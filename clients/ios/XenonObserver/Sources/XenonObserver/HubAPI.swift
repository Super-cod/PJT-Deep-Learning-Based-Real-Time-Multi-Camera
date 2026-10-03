import Foundation

/// HTTP side of the hub: room model and shared ARWorldMap upload / download.
struct HubAPI {
    let host: String
    let port: Int

    private var base: URL? { URL(string: "http://\(host):\(port)") }

    enum APIError: LocalizedError {
        case noHub, http(Int), noWorldMap
        var errorDescription: String? {
            switch self {
            case .noHub: "Hub address not set"
            case .http(let code): "Hub returned HTTP \(code)"
            case .noWorldMap: "No shared map on the hub yet — scan the rooms first"
            }
        }
    }

    func upload(_ data: Data, to path: String, contentType: String) async throws {
        guard let url = base?.appendingPathComponent(path) else { throw APIError.noHub }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 120
        let (_, response) = try await URLSession.shared.upload(for: request, from: data)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw APIError.http(code) }
    }

    func fetchRoom() async throws -> RoomResponse {
        guard let url = base?.appendingPathComponent("api/room") else { throw APIError.noHub }
        let (data, response) = try await URLSession.shared.data(from: url)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 200 else { throw APIError.http(code) }
        return try JSONDecoder().decode(RoomResponse.self, from: data)
    }

    func downloadWorldMap() async throws -> Data {
        guard let url = base?.appendingPathComponent("api/worldmap") else { throw APIError.noHub }
        var request = URLRequest(url: url)
        request.timeoutInterval = 120
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if code == 404 { throw APIError.noWorldMap }
        guard code == 200 else { throw APIError.http(code) }
        return data
    }
}
