import Foundation

final class WebSocketRelay {
    // Change only this address to your laptop LAN IPv4 address.
    private let serverHost = "192.168.1.25"
    private var task: URLSessionWebSocketTask?
    func connect() {
        task = URLSession.shared.webSocketTask(with: URL(string: "ws://\(serverHost):8000/ws/observer")!)
        task?.resume()
    }
    func send<T: Encodable>(_ value: T) {
        guard let data = try? JSONEncoder().encode(value), let text = String(data: data, encoding: .utf8) else { return }
        task?.send(.string(text)) { _ in }
    }
}
