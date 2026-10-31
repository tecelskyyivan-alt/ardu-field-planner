import os as _root_os, sys as _root_sys  # moved from the repo root into tests/: keep the root importable
ROOT_DIR = _root_os.path.dirname(_root_os.path.dirname(_root_os.path.abspath(__file__)))
_root_sys.path.insert(0, ROOT_DIR)
"""scripts/udp_ws_bridge.py: only FMP itself may open the WebSocket to the drone.

Starts the bridge on a free port (no drone needed) and checks which WebSocket
handshakes it accepts: a foreign web page or a DNS-rebinding Host must get 403.
"""
import base64
import os
import socket
import subprocess
import sys
import time

with socket.socket() as _s:
    _s.bind(("127.0.0.1", 0))
    PORT = _s.getsockname()[1]
bridge = subprocess.Popen([sys.executable, os.path.join(ROOT_DIR,
                                                        "scripts", "udp_ws_bridge.py"), str(PORT)],
                          stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
failed = False


def check(name, cond):
    global failed
    print(("  OK  " if cond else " FAIL ") + name)
    failed |= not cond


def handshake(origin, host=None):
    s = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    hdr = (f"GET / HTTP/1.1\r\nHost: {host or f'127.0.0.1:{PORT}'}\r\nUpgrade: websocket\r\n"
           f"Connection: Upgrade\r\nSec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\n"
           "Sec-WebSocket-Version: 13\r\n")
    if origin:
        hdr += f"Origin: {origin}\r\n"
    s.sendall((hdr + "\r\n").encode())
    line = s.recv(200).split(b"\r\n")[0].decode()
    s.close()
    return line.split(" ")[1] if " " in line else line


try:
    for _ in range(50):
        try:
            socket.create_connection(("127.0.0.1", PORT), timeout=1).close()
            break
        except OSError:
            time.sleep(0.1)
    check("FMP served by the bridge (same origin) -> 101", handshake(f"http://127.0.0.1:{PORT}") == "101")
    check("FMP on GitHub Pages -> 101", handshake("https://tecelskyyivan-alt.github.io") == "101")
    check("phone over LAN (Origin = its Host IP) -> 101",
          handshake(f"http://192.0.2.5:{PORT}", f"192.0.2.5:{PORT}") == "101")
    check("non-browser client (no Origin) -> 101", handshake(None) == "101")
    check("foreign web page -> 403", handshake("https://evil.example") == "403")
    check("other github.io site -> 403", handshake("https://evil.github.io") == "403")
    check("DNS-rebinding Host -> 403",
          handshake(f"http://evil.example:{PORT}", f"evil.example:{PORT}") == "403")

    print("\n== UDP: another host on the WiFi can't become 'the drone' ==")
    ws = socket.create_connection(("127.0.0.1", PORT), timeout=5)
    ws.sendall((f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{PORT}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {base64.b64encode(os.urandom(16)).decode()}\r\n\r\n").encode())
    ws.recv(200)
    drone, intruder = (socket.socket(socket.AF_INET, socket.SOCK_DGRAM) for _ in range(2))
    for u in (drone, intruder):
        u.bind(("127.0.0.1", 0)); u.settimeout(1)

    def ws_recv_all(wait=0.4):
        time.sleep(wait); ws.settimeout(0.2); out = b""
        try:
            while True:
                chunk = ws.recv(4096)
                if not chunk:
                    break
                out += chunk
        except socket.timeout:
            pass
        return out

    def ws_send(payload):           # masked binary frame, as a browser sends
        mask = os.urandom(4)
        ws.sendall(bytes([0x82, 0x80 | len(payload)]) + mask + bytes(c ^ mask[i % 4] for i, c in enumerate(payload)))

    def udp_got(u):
        try:
            return u.recv(100)
        except socket.timeout:
            return b""

    drone.sendto(b"DRONE-1", ("127.0.0.1", PORT))
    got = ws_recv_all()
    intruder.sendto(b"EVIL-1", ("127.0.0.1", PORT))
    got += ws_recv_all()
    check("drone telemetry reaches FMP", b"DRONE-1" in got)
    check("intruder packet dropped while the drone talks", b"EVIL-1" not in got)
    ws_send(b"CMD-1")
    check("command goes to the drone", udp_got(drone) == b"CMD-1")
    check("intruder gets no command", udp_got(intruder) == b"")
    time.sleep(3.2)                                       # drone silent > PEER_HOLD
    intruder.sendto(b"NEW-1", ("127.0.0.1", PORT))
    check("after 3 s of silence a new sender takes over (backpack reboot)", b"NEW-1" in ws_recv_all())

    ws.sendall(bytes([0x82, 0xFF]) + (1 << 40).to_bytes(8, "big") + os.urandom(4))   # claims 1 TB
    ws.settimeout(3)
    try:
        closed = ws.recv(10) == b""
    except (socket.timeout, ConnectionError):
        closed = False
    check("oversized WS frame -> connection closed, no allocation", closed and bridge.poll() is None)
    ws.close()
finally:
    bridge.kill()

print("\n== desktop link (pymavlink udpin): same peer pinning ==")
try:
    from pymavlink import mavutil
    sys.path.insert(0, ROOT_DIR)
    from backend.mavlink_link import _pin_udp_peer
    with socket.socket() as _s:
        _s.bind(("127.0.0.1", 0)); UPORT = _s.getsockname()[1]
    conn = mavutil.mavlink_connection(f"udpin:127.0.0.1:{UPORT}")
    _pin_udp_peer(conn)
    drone, intruder = (socket.socket(socket.AF_INET, socket.SOCK_DGRAM) for _ in range(2))
    for u in (drone, intruder):
        u.bind(("127.0.0.1", 0)); u.settimeout(1)

    def pull():
        time.sleep(0.1)
        return conn.recv()

    drone.sendto(b"D", ("127.0.0.1", UPORT))
    check("drone packet accepted", pull() == b"D")
    intruder.sendto(b"E", ("127.0.0.1", UPORT))
    check("intruder packet dropped", pull() == "")
    conn.write(b"CMD")
    check("command only to the drone", udp_got(drone) == b"CMD" and udp_got(intruder) == b"")
    conn.close()
except ImportError as exc:
    check(f"pymavlink available ({exc})", False)

print("\nRESULT: " + ("ALL CHECKS PASSED" if not failed else "FAILURES ABOVE"))
sys.exit(1 if failed else 0)
