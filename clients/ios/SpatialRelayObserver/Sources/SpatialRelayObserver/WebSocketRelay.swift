import Foundation

/// WebSocket client for the hub with automatic reconnect (1 s → 2 s → … → 10 s).
/// All methods must be called on the main thread.
final class WebSocketRelay: ObservableObject {
    enum State: String { case disconnected, connecting, connected }

    @Published private(set) var state: State = .disconnected
    var onMessage: ((InboundMessage) -> Void)?

    private let session = URLSession(configuration: .default)
    private let encoder = JSONEncoder()
    private var task: URLSessionWebSocketTask?
    private var url: URL?
    private var retry = 0
    /// Bumped whenever the current socket is replaced; stale callbacks compare against it.
    private var generation = 0

    func connect(to url: URL) {
        self.url = url
        retry = 0
        open()
    }

    func reconnect() {
        retry = 0
        open()
    }

    func send<T: Encodable>(_ value: T) {
        guard state == .connected, let task,
              let data = try? encoder.encode(value),
              let text = String(data: data, encoding: .utf8) else { return }
        task.send(.string(text)) { _ in }
    }

    private func open() {
        guard let url else { return }
        generation += 1
        let gen = generation
        task?.cancel(with: .goingAway, reason: nil)
        state = .connecting

        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
        // URLSessionWebSocketTask has no "open" callback; a ping round-trip confirms it.
        task.sendPing { [weak self] error in
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                if error == nil {
                    self.state = .connected
                    self.retry = 0
                } else {
                    self.scheduleReconnect(gen)
                }
            }
        }
        receive(task, gen)
    }

    private func receive(_ task: URLSessionWebSocketTask, _ gen: Int) {
        task.receive { [weak self] result in
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                switch result {
                case .success(.string(let text)):
                    if let data = text.data(using: .utf8),
                       let msg = try? JSONDecoder().decode(InboundMessage.self, from: data) {
                        self.onMessage?(msg)
                    }
                    self.receive(task, gen)
                case .success:
                    self.receive(task, gen)
                case .failure:
                    self.scheduleReconnect(gen)
                }
            }
        }
    }

    private func scheduleReconnect(_ gen: Int) {
        guard gen == generation else { return }
        generation += 1
        let target = generation
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        state = .disconnected
        let delay = min(pow(2, Double(retry)), 10)
        retry += 1
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self, self.generation == target else { return }
            self.open()
        }
    }
}
