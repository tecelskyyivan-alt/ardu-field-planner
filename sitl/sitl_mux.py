"""Tiny MAVLink TCP fan-out so several ground stations can share ONE SITL.

The ArduCopter SITL binary exposes a single TCP endpoint (serial0 on :5760).
This mux is its only client; it then re-serves the byte stream on two local TCP
ports so Mission Planner (visual) and our app (mission/control) can both connect
to the same simulated vehicle at once.

  SITL :5760  ──►  mux  ──►  :5762  (Mission Planner)
                        └─►  :5763  (Field Mission Planner app)

Bytes from any downstream client are forwarded up to SITL; bytes from SITL are
broadcast to every connected downstream client. Pure byte relay — MAVLink itself
handles multiple GCS talking to one autopilot.
"""
import socket
import select
import time

UPSTREAM = ("127.0.0.1", 5760)
DOWN_PORTS = [5762, 5763]


def _connect_upstream():
    while True:
        try:
            s = socket.create_connection(UPSTREAM, timeout=5)
            s.setblocking(False)
            print("mux: connected to SITL", UPSTREAM, flush=True)
            return s
        except OSError:
            print("mux: waiting for SITL on", UPSTREAM, "...", flush=True)
            time.sleep(1.0)


def main():
    up = _connect_upstream()
    servers = []
    for p in DOWN_PORTS:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        srv.bind(("127.0.0.1", p))
        srv.listen(2)
        srv.setblocking(False)
        servers.append(srv)
        print("mux: serving downstream on TCP", p, flush=True)

    clients = []
    while True:
        try:
            rlist = [up] + servers + clients
            r, _, _ = select.select(rlist, [], [], 1.0)
        except (OSError, ValueError):
            r = []
        for sock in r:
            if sock is up:
                try:
                    data = up.recv(8192)
                except OSError:
                    data = b""
                if not data:
                    print("mux: SITL dropped — reconnecting", flush=True)
                    try:
                        up.close()
                    except OSError:
                        pass
                    up = _connect_upstream()
                    break
                for c in list(clients):
                    try:
                        c.sendall(data)
                    except OSError:
                        clients.remove(c)
                        try:
                            c.close()
                        except OSError:
                            pass
            elif sock in servers:
                try:
                    c, addr = sock.accept()
                    c.setblocking(False)
                    clients.append(c)
                    print("mux: client connected", addr, flush=True)
                except OSError:
                    pass
            else:  # a downstream client
                try:
                    data = sock.recv(8192)
                except OSError:
                    data = b""
                if not data:
                    clients.remove(sock)
                    try:
                        sock.close()
                    except OSError:
                        pass
                    print("mux: client left", flush=True)
                else:
                    try:
                        up.sendall(data)
                    except OSError:
                        pass


if __name__ == "__main__":
    main()
