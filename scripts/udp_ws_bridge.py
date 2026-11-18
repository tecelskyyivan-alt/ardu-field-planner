#!/usr/bin/env python3
"""UDP <-> WebSocket bridge so the FMP web app in a desktop browser can use a WiFi MAVLink
link (ELRS backpack, ESP bridge). Browsers can't receive UDP; this listens for MAVLink on
UDP 0.0.0.0:14550 and hands it to FMP over ws://127.0.0.1:14550 (and back).

It also serves FMP itself at http://127.0.0.1:14550: Chrome blocks a public site (GitHub
Pages) from reaching 127.0.0.1 (Local Network Access), but a page from 127.0.0.1 may.

Run:   python3 scripts/udp_ws_bridge.py        (stdlib only, no installs)
Open:  http://127.0.0.1:14550  ->  Flight -> UDP, address empty (auto) -> Connect.

Phones: a phone browser can't run the bridge itself. With --lan the bridge also listens on
the local network, and the phone opens FMP from it: http://<this computer's IP>:14550.
Anyone on that WiFi can then reach the drone through it, so use --lan only on your own network.
"""
import asyncio, base64, hashlib, mimetypes, struct, sys, time
from pathlib import Path

ARGS = [a for a in sys.argv[1:] if a != "--lan"]
LAN = "--lan" in sys.argv[1:]
UDP_PORT = int(ARGS[0]) if ARGS else 14550
WS_HOST, WS_PORT = ("0.0.0.0" if LAN else "127.0.0.1"), UDP_PORT   # same number, TCP vs UDP don't clash
GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
WEB = (Path(__file__).resolve().parent.parent / "web-stable").resolve()
# Pyodide (~27 MB) is not in git; same pinned build the Pages deploy uses (.github/pyodide.sha256).
PYODIDE_CDN = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/"
# FMP on Pages talks to the bridge directly when Chrome allows it (and via relay.html otherwise).
PAGES_ORIGIN = "https://tecelskyyivan-alt.github.io"
mimetypes.add_type("application/wasm", ".wasm")
mimetypes.add_type("text/javascript", ".mjs")

clients = set()     # open WebSocket writers
peer = None         # backpack address, learned from its first packet
stats = {"udp_in": 0, "ws_in": 0, "foreign": 0}
last_rx = 0.0      # when the current peer last spoke
PEER_HOLD = 3.0    # s: another sender may take over only after the peer is this long silent
MAX_FRAME = 65536  # bytes: MAVLink frames are < 300; bigger is junk or a memory-exhaustion try


def ws_frame(payload: bytes) -> bytes:
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x82, n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x82, 126, n)
    else:
        head = struct.pack("!BBQ", 0x82, 127, n)
    return head + payload


class Udp(asyncio.DatagramProtocol):
    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        global peer, last_rx
        if addr[1] == UDP_PORT and addr[0] in ("127.0.0.1", lan_ip()):   # IP re-read: WiFi may change
            return  # our own broadcast echoed back: learning it as "the backpack" loops FMP onto itself
        now = time.monotonic()
        if peer and addr != peer and now - last_rx < PEER_HOLD:
            # Anyone on the WiFi could otherwise become "the drone" with one packet: get our
            # commands and feed us fake telemetry. Ignore them while the real peer is talking.
            if not stats["foreign"]:
                print(f"UDP: ignoring {addr[0]}:{addr[1]} — the drone is {peer[0]}:{peer[1]}", flush=True)
            stats["foreign"] += 1
            return
        last_rx = now
        if peer != addr:
            print(f"UDP: MAVLink from {addr[0]}:{addr[1]}", flush=True)
            peer = addr
        stats["udp_in"] += 1
        frame = ws_frame(data)
        for w in list(clients):
            w.write(frame)


def allowed(host, origin):
    """Only FMP itself may drive the drone: any web page can open a WebSocket to 127.0.0.1
    (no CORS for WS), so a foreign Origin is refused. Host must be an IP literal or
    localhost, which DNS rebinding (needs a domain name) can't fake."""
    import ipaddress, urllib.parse
    name = urllib.parse.urlsplit("//" + (host or "")).hostname or ""
    if name != "localhost":
        try:
            ipaddress.ip_address(name)
        except ValueError:
            return False
    return origin is None or origin in ("http://" + host, PAGES_ORIGIN)


def http_response(request_line: str) -> bytes:
    parts = request_line.split(" ")
    path = parts[1].split("?", 1)[0] if len(parts) > 1 else "/"
    if path == "/ping":     # FMP on Pages checks whether Chrome lets it reach this computer
        return (b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nAccess-Control-Allow-Origin: *\r\n"
                b"Access-Control-Allow-Private-Network: true\r\n\r\nok")
    if path.startswith("/pyodide/"):
        return f"HTTP/1.1 302 Found\r\nLocation: {PYODIDE_CDN}{path[9:]}\r\nContent-Length: 0\r\n\r\n".encode()
    f = (WEB / path.lstrip("/")).resolve()
    if f.is_dir():
        f = f / "index.html"
    if WEB not in f.parents or not f.is_file():     # also refuses ../ escapes
        return b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n"
    body = f.read_bytes()
    ctype = mimetypes.guess_type(f.name)[0] or "application/octet-stream"
    return (f"HTTP/1.1 200 OK\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
            "Cache-Control: no-cache\r\n\r\n").encode() + body


async def handle_ws(reader, writer, udp):
    try:
        first = await reader.readexactly(1)
        if first == b"\x16":   # TLS ClientHello: the browser tried https first; drop it fast so it falls back to http
            writer.close(); return
        head = first + await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError):
        writer.close(); return
    key = next((l.split(b":", 1)[1].strip() for l in head.split(b"\r\n")
                if l.lower().startswith(b"sec-websocket-key:")), None)
    if not key:     # plain HTTP: serve the FMP web app
        writer.write(http_response(head.split(b"\r\n", 1)[0].decode(errors="replace")))
        await writer.drain(); writer.close(); return
    hdr = {k.strip().lower(): v.strip() for k, _, v in
           (l.decode(errors="replace").partition(":") for l in head.split(b"\r\n")[1:] if b":" in l)}
    if not allowed(hdr.get("host"), hdr.get("origin")):
        print(f"WS: refused origin {hdr.get('origin')!r} host {hdr.get('host')!r}", flush=True)
        writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n")
        await writer.drain(); writer.close(); return
    accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
    writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                 b"Sec-WebSocket-Accept: " + accept + b"\r\n\r\n")
    clients.add(writer)
    print("WS: FMP connected" + ("" if peer else " (no UDP from the backpack yet)"), flush=True)
    try:
        while True:
            b0, b1 = await reader.readexactly(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n, = struct.unpack("!H", await reader.readexactly(2))
            elif n == 127:
                n, = struct.unpack("!Q", await reader.readexactly(8))
            if n > MAX_FRAME:
                break
            mask = await reader.readexactly(4) if b1 & 0x80 else b"\0\0\0\0"
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(await reader.readexactly(n)))
            if op == 0x8:                                   # close
                break
            if op == 0x9:                                   # ping -> pong
                writer.write(struct.pack("!BB", 0x8A, len(data)) + data); continue
            if op in (0x1, 0x2, 0x0):                       # text/binary/continuation -> UDP
                stats["ws_in"] += 1
                if peer:
                    udp.sendto(data, peer)
                else:   # nobody heard yet: broadcast so a backpack waiting for a GCS hears us
                    udp.sendto(data, ("255.255.255.255", UDP_PORT))
    except (asyncio.IncompleteReadError, ConnectionError):
        pass
    finally:
        clients.discard(writer)
        writer.close()
        print("WS: FMP disconnected", flush=True)


async def report():
    while True:
        await asyncio.sleep(10)
        print(f"… UDP in {stats['udp_in']} pkts, FMP->drone {stats['ws_in']} pkts, "
              f"backpack {peer[0] if peer else 'not heard'}", flush=True)


def lan_ip():
    import socket
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 9))     # no packet is sent; picks the interface with the default route
        return s.getsockname()[0]
    except OSError:
        return "<IP цього комп'ютера>"
    finally:
        s.close()


async def main():
    import socket
    loop = asyncio.get_running_loop()
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.bind(("0.0.0.0", UDP_PORT))
    udp, _ = await loop.create_datagram_endpoint(Udp, sock=sock)
    server = await asyncio.start_server(lambda r, w: handle_ws(r, w, udp), WS_HOST, WS_PORT)
    print(f"Bridge: UDP 0.0.0.0:{UDP_PORT}  <->  ws://{WS_HOST}:{WS_PORT}. Ctrl+C to stop.", flush=True)
    print(f"Open FMP: http://127.0.0.1:{WS_PORT}", flush=True)
    if LAN:
        print(f"Phones on this WiFi: http://{lan_ip()}:{WS_PORT}", flush=True)
    asyncio.create_task(report())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
