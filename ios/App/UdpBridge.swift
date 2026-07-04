import Foundation
import Network

/// MAVLink-over-UDP for the WiFi / ELRS backpack — the link iOS Safari can't make
/// (browsers have no raw UDP). Mirrors the Android `AndroidUdp` bridge:
///   open(port)  — bind a local UDP port (udpin) and listen on every interface,
///                 learning the peer (the backpack) from the first datagram so the
///                 GCS heartbeat we send is routed straight back to it;
///   write(data) — send to the most-recent peer;
///   close()     — tear everything down.
/// Incoming datagrams are handed to `onData`; lifecycle to `onEvent`.
final class UdpBridge {
    var onData: ((Data) -> Void)?
    var onEvent: ((_ type: String, _ ok: Bool, _ detail: String?) -> Void)?

    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private var activeConn: NWConnection?
    private let queue = DispatchQueue(label: "fmp.udp")

    func open(port: UInt16) {
        close()
        guard let nwPort = NWEndpoint.Port(rawValue: port == 0 ? 14550 : port) else {
            onEvent?("open", false, "невірний порт"); return
        }
        do {
            let params = NWParameters.udp
            params.allowLocalEndpointReuse = true
            let l = try NWListener(using: params, on: nwPort)
            l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
            l.stateUpdateHandler = { [weak self] state in
                switch state {
                case .ready:
                    self?.onEvent?("open", true, nil)
                case .failed(let err):
                    self?.onEvent?("open", false, err.localizedDescription)
                case .cancelled:
                    break
                default:
                    break
                }
            }
            self.listener = l
            l.start(queue: queue)
        } catch {
            onEvent?("open", false, error.localizedDescription)
        }
    }

    func write(_ data: Data) {
        guard let c = activeConn else { return }
        c.send(content: data, completion: .contentProcessed { _ in })
    }

    func close() {
        listener?.cancel(); listener = nil
        for c in connections { c.cancel() }
        connections.removeAll()
        activeConn = nil
    }

    // MARK: - private

    private func accept(_ conn: NWConnection) {
        connections.append(conn)
        activeConn = conn
        conn.stateUpdateHandler = { [weak self] st in
            switch st {
            case .failed, .cancelled: self?.drop(conn)
            default: break
            }
        }
        receive(on: conn)
        conn.start(queue: queue)
    }

    private func receive(on conn: NWConnection) {
        conn.receiveMessage { [weak self] data, _, _, err in
            guard let self = self else { return }
            if let d = data, !d.isEmpty {
                self.activeConn = conn        // reply to whoever last spoke to us
                self.onData?(d)
            }
            if err == nil { self.receive(on: conn) }
        }
    }

    private func drop(_ conn: NWConnection) {
        connections.removeAll { $0 === conn }
        if activeConn === conn { activeConn = connections.last }
    }
}
