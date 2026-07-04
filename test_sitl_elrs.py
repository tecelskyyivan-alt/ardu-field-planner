r"""Realistic-conditions E2E: our MAVLink GCS ↔ a simulated ELRS link ↔ the REAL
ArduCopter SITL.

test_sitl.py drives SITL over a clean TCP socket. Real field use is over an
ExpressLRS RF link: lossy, latent, bandwidth-limited, and ASYMMETRIC (the 1:2
telemetry ratio makes the GCS→FC uplink the bottleneck — exactly what broke
telemetry-streams and mission-upload in the field). This test inserts an
ELRS-emulating proxy between the GCS and SITL and proves the link survives it:

    GCS (our MavLink)  <──tcp:PROXY──>  [ELRS proxy: loss+latency+bw, per frame]
                                            <──tcp:5760──>  ArduCopter SITL

The proxy degrades whole MAVLink FRAMES (like ELRS relaying discrete messages,
not a byte pipe). It holds ONE persistent socket to SITL (SITL's SERIAL0 exits
when its client drops — the reason sitl_mux exists), and the GCS connects to the
proxy. Asserts, all THROUGH the degraded link:
  • a live heartbeat arrives;
  • GPS/position telemetry comes up despite dropped stream-request packets
    (proves the SET_MESSAGE_INTERVAL re-request self-heals — a one-shot would
    never recover a dropped request);
  • a representative spraying mission uploads AND read-back-verifies despite
    latency + loss (proves the progress timeout + gentle COUNT re-announce).

Run:  .\.venv\Scripts\python.exe test_sitl_elrs.py
"""
import os
import random
import socket
import subprocess
import sys
import threading
import time

from backend.mavlink_link import MavLink, build_mission_items

ROOT = os.path.dirname(os.path.abspath(__file__))
SITL_DIR = os.path.join(ROOT, "sitl")
SITL_EXE = os.path.join(SITL_DIR, "ArduCopter.exe" if os.name=="nt" else "arducopter")
SITL_PORT = 5760
PROXY_PORT = 5764            # the GCS connects here; proxy relays to SITL :5760
HOME = (49.5275, 24.004, 200.0)

# --- ELRS link emulation (per-direction, frame-level). Asymmetric: the uplink
# (GCS→FC) is the constrained side under the 1:2 telemetry ratio. Deterministic
# seed so the run is reproducible.
random.seed(20260623)
UPLINK = dict(loss=0.10, lat=0.13, jitter=0.05, rate=15.0)   # GCS → SITL (the 1:2-ratio bottleneck)
DOWNLINK = dict(loss=0.05, lat=0.13, jitter=0.05, rate=40.0)  # SITL → GCS
# NOTE: mission upload over a VERY lossy RF link (>15%) can be REJECTED by ArduPilot
# (retransmit/seq confusion), not just stalled — which is why USB is the reliable
# path for upload and the backpack is best for telemetry + in-flight control. These
# rates model a *working* ELRS link (clearly degraded, but upload still completes).


def check(name, cond):
    print(("  OK  " if cond else " FAIL ") + name, flush=True)
    if not cond:
        check.failed = True


check.failed = False


def split_frames(buf):
    """Split a byte buffer into complete MAVLink v1/v2 frames; return (frames, rest).
    Resyncs past junk so a dropped/partial frame can't desync the stream."""
    frames = []
    i, n = 0, len(buf)
    while i < n:
        b = buf[i]
        if b == 0xFE:                      # v1: STX, len, ... , crc(2)
            if i + 2 > n:
                break
            total = buf[i + 1] + 8
        elif b == 0xFD:                    # v2: STX, len, incompat, ...
            if i + 3 > n:
                break
            total = buf[i + 1] + 12 + (13 if (buf[i + 2] & 0x01) else 0)
        else:
            i += 1                         # not a frame start — skip and resync
            continue
        if i + total > n:
            break                          # incomplete — wait for more bytes
        frames.append(bytes(buf[i:i + total]))
        i += total
    return frames, buf[i:]


class ElrsProxy:
    """Frame-level lossy/latent/bandwidth-limited TCP relay between the GCS and SITL."""

    def __init__(self, sitl_port, listen_port):
        self.sitl_port = sitl_port
        self.listen_port = listen_port
        self.stop = threading.Event()
        self.sitl = None
        self.stats = {"up_drop": 0, "up_pass": 0, "down_drop": 0, "down_pass": 0}

    def connect_sitl(self, timeout=30):
        end = time.time() + timeout
        while time.time() < end and not self.stop.is_set():
            try:
                s = socket.create_connection(("127.0.0.1", self.sitl_port), timeout=3)
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                self.sitl = s
                return True
            except OSError:
                time.sleep(1.0)
        return False

    def _relay(self, src, dst, cfg, key):
        """Read frames from src, drop/delay/rate-limit, write to dst. A sender thread
        drains a due-ordered queue so latency and bandwidth are modelled independently."""
        q = []          # list of (deliver_at, frame)
        qlock = threading.Lock()

        def sender():
            next_ok = 0.0
            gap = 1.0 / cfg["rate"]
            while not self.stop.is_set():
                now = time.time()
                frame = None
                with qlock:
                    if q and q[0][0] <= now and now >= next_ok:
                        frame = q.pop(0)[1]
                if frame is None:
                    time.sleep(0.005)
                    continue
                try:
                    dst.sendall(frame)
                except OSError:
                    self.stop.set()
                    return
                next_ok = time.time() + gap
        threading.Thread(target=sender, daemon=True).start()

        buf = bytearray()
        while not self.stop.is_set():
            try:
                chunk = src.recv(4096)
            except OSError:
                break
            if not chunk:
                break
            buf.extend(chunk)
            frames, buf = split_frames(buf)
            for fr in frames:
                if random.random() < cfg["loss"]:
                    self.stats[key + "_drop"] += 1
                    continue
                self.stats[key + "_pass"] += 1
                delay = cfg["lat"] + random.uniform(0, cfg["jitter"])
                with qlock:
                    q.append((time.time() + delay, fr))

    def serve_one(self):
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", self.listen_port))
        srv.listen(1)
        srv.settimeout(1.0)
        while not self.stop.is_set():
            try:
                gcs, _ = srv.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            gcs.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # GCS→SITL uplink (harsh) and SITL→GCS downlink (moderate).
            threading.Thread(target=self._relay, args=(gcs, self.sitl, UPLINK, "up"), daemon=True).start()
            threading.Thread(target=self._relay, args=(self.sitl, gcs, DOWNLINK, "down"), daemon=True).start()
            # Keep the SITL socket open across GCS disconnects (one GCS is enough here).
            while not self.stop.is_set():
                time.sleep(0.5)
        try:
            srv.close()
        except OSError:
            pass


def kill_sitl():
    try:
        subprocess.run((["taskkill","/IM","ArduCopter.exe","/F"] if os.name=="nt" else ["pkill","-f","ardu"]), capture_output=True)
    except Exception:
        pass


def main():
    if not os.path.exists(SITL_EXE):
        print(f"SITL binary not found: {SITL_EXE}")
        sys.exit(2)
    kill_sitl()
    time.sleep(1.0)

    args = [SITL_EXE, "-M", "quad", "--home", "49.5275,24.004,200,0", "-I0",
            "--defaults", "test_params.parm"]
    out = open(os.path.join(SITL_DIR, "sitl_elrs.log"), "w")
    err = open(os.path.join(SITL_DIR, "sitl_elrs_err.log"), "w")
    print("== launching ArduCopter SITL ==", flush=True)
    proc = subprocess.Popen(args, cwd=SITL_DIR, stdout=out, stderr=err)

    proxy = ElrsProxy(SITL_PORT, PROXY_PORT)
    link = MavLink()
    try:
        time.sleep(4.0)
        print("== ELRS proxy connecting to SITL (held open) ==", flush=True)
        if not proxy.connect_sitl(timeout=30):
            check("proxy connected to SITL", False)
            return
        threading.Thread(target=proxy.serve_one, daemon=True).start()
        print(f"   uplink   loss={UPLINK['loss']:.0%} lat={UPLINK['lat']*1000:.0f}ms rate={UPLINK['rate']:.0f}/s", flush=True)
        print(f"   downlink loss={DOWNLINK['loss']:.0%} lat={DOWNLINK['lat']*1000:.0f}ms rate={DOWNLINK['rate']:.0f}/s", flush=True)

        print("== GCS connecting THROUGH the ELRS proxy ==", flush=True)
        res = None
        end = time.time() + 30
        while time.time() < end:
            res = link.connect(f"tcp:127.0.0.1:{PROXY_PORT}")
            if res.get("ok"):
                break
            time.sleep(1.0)
        check("GCS connected through degraded link", bool(res and res.get("ok")))
        if not (res and res.get("ok")):
            return

        # Heartbeat through the lossy link.
        connected = False
        for _ in range(80):
            if link.status().get("connected"):
                connected = True
                break
            time.sleep(0.5)
        check("heartbeat arrives through ELRS loss/latency", connected)
        if not connected:
            return

        # THE telemetry-stream test: GPS/position must come up even though stream
        # requests are dropped ~15% of the time on the uplink. A one-shot request
        # (old code) would simply never recover a dropped request — the new
        # self-healing re-request must keep trying until data flows.
        # Wait until BOTH the fast position stream (2 Hz) and the slow battery
        # stream (SYS_STATUS, 0.5 Hz) have arrived — proving each requested message
        # really streams over the lossy uplink, not just the first one.
        t0 = time.time()
        got_gps = got_batt = False
        for _ in range(120):                       # up to ~60 s
            s = link.status()
            if s.get("fix_type") is not None and s.get("sats") is not None and s.get("lat") is not None:
                got_gps = True
            if s.get("battery_v") is not None:
                got_batt = True
            if got_gps and got_batt:
                break
            time.sleep(0.5)
        dt = time.time() - t0
        s = link.status()
        print(f"   telemetry up in {dt:.1f}s: fix={s.get('fix_type')} sats={s.get('sats')} "
              f"lat={s.get('lat')} batt={s.get('battery_v')} gs={s.get('groundspeed')}", flush=True)
        check("GPS/position telemetry self-heals over the lossy uplink", got_gps)
        check("battery telemetry also arrived (SYS_STATUS streamed)", got_batt)

        # Mission upload + read-back verify THROUGH the degraded link.
        wps = [(49.5280, 24.0045), (49.5285, 24.0045), (49.5285, 24.0055),
               (49.5280, 24.0055), (49.5280, 24.0065), (49.5285, 24.0065),
               (49.5290, 24.0065), (49.5290, 24.0045)]
        items = build_mission_items(HOME, takeoff_alt=15.0, waypoints=wps,
                                    wp_alt=40.0, rtl=True, speed=6.0)
        print(f"== upload {len(items)} items through the ELRS link ==", flush=True)
        t0 = time.time()
        up = link.upload_mission(items)
        dt = time.time() - t0
        print(f"   upload finished in {dt:.1f}s -> {up.get('ok')} "
              f"{up.get('warning') or up.get('error') or ''}", flush=True)
        check("mission uploaded over the degraded link", up.get("ok"))
        check("upload count matches", up.get("count") == len(items))

        if up.get("ok"):
            print("== read-back verify through the ELRS link ==", flush=True)
            v = link.verify_mission(items)
            check("verify ran", v.get("ok"))
            check("verify VERIFIED (ArduPilot stored exactly what we sent)",
                  v.get("verified") is True)
            if v.get("mismatches"):
                print(f"   mismatches: {v['mismatches']}", flush=True)

        st = proxy.stats
        up_total = st["up_pass"] + st["up_drop"]
        down_total = st["down_pass"] + st["down_drop"]
        print(f"   link stats: uplink {st['up_drop']}/{up_total} frames dropped, "
              f"downlink {st['down_drop']}/{down_total} dropped", flush=True)
        check("the link really WAS degraded (frames were dropped)",
              st["up_drop"] + st["down_drop"] > 0)

    finally:
        proxy.stop.set()
        try:
            link.disconnect()
        except Exception:
            pass
        try:
            if proxy.sitl:
                proxy.sitl.close()
        except Exception:
            pass
        try:
            proc.terminate(); proc.wait(timeout=5)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass
        kill_sitl()
        try:
            out.close(); err.close()
        except Exception:
            pass

    print(flush=True)
    if check.failed:
        print("RESULT: FAILURES PRESENT")
        sys.exit(1)
    print("RESULT: ALL CHECKS PASSED")


if __name__ == "__main__":
    main()
