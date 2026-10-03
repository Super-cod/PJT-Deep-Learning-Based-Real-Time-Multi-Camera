import ARKit
import Foundation
import RoomPlan
import simd

/// Scans one or more rooms with RoomPlan on the app's own ARSession, so the
/// scanned model shares the live tracking frame (and the ARWorldMap saved
/// afterwards). Rooms are merged with StructureBuilder.
final class RoomScanner: NSObject, ObservableObject, RoomCaptureSessionDelegate {
    enum State: Equatable { case idle, scanning, processing, roomReady, failed(String) }

    @Published private(set) var state: State = .idle
    @Published private(set) var roomsCaptured = 0
    @Published private(set) var liveSummary = ""
    @Published private(set) var instruction = ""
    /// Top-down outline of what has been captured so far (x, z in metres).
    @Published private(set) var planWalls: [PlanSegment] = []
    @Published private(set) var planOpenings: [PlanSegment] = []
    /// Live captured room, for the AR overlay.
    var onRoomUpdate: ((CapturedRoom) -> Void)?

    struct PlanSegment: Hashable {
        let a: SIMD2<Float>
        let b: SIMD2<Float>
    }
    /// Walls of rooms already finished, kept on the plan while the next one is scanned.
    private var finishedPlanWalls: [PlanSegment] = []

    static var isSupported: Bool { RoomCaptureSession.isSupported }

    private var captureSession: RoomCaptureSession?
    private var rooms: [CapturedRoom] = []

    /// Start (or continue with) the next room on the shared ARSession.
    func startRoom(on arSession: ARSession) {
        if captureSession == nil {
            let capture = RoomCaptureSession(arSession: arSession)
            capture.delegate = self
            captureSession = capture
        }
        liveSummary = ""
        instruction = ""
        state = .scanning
        captureSession?.run(configuration: RoomCaptureSession.Configuration())
    }

    /// Stop the current room but keep the ARSession (and its frame) running.
    func finishRoom() {
        guard state == .scanning else { return }
        state = .processing
        captureSession?.stop(pauseARSession: false)
    }

    func reset() {
        captureSession = nil
        rooms = []
        roomsCaptured = 0
        liveSummary = ""
        planWalls = []
        planOpenings = []
        finishedPlanWalls = []
        state = .idle
    }

    /// Merge all captured rooms and return the compact JSON the hub stores.
    func exportModel() async throws -> Data {
        let model: RoomModel
        if rooms.count > 1 {
            let structure = try await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: rooms)
            model = RoomModel(
                rooms: structure.rooms.count,
                walls: structure.walls.map(RoomModel.Surface.init),
                doors: structure.doors.map(RoomModel.Surface.init),
                windows: structure.windows.map(RoomModel.Surface.init),
                openings: structure.openings.map(RoomModel.Surface.init),
                floors: structure.floors.map(RoomModel.Surface.init),
                objects: structure.objects.map(RoomModel.Object.init)
            )
        } else if let room = rooms.first {
            model = RoomModel(
                rooms: 1,
                walls: room.walls.map(RoomModel.Surface.init),
                doors: room.doors.map(RoomModel.Surface.init),
                windows: room.windows.map(RoomModel.Surface.init),
                openings: room.openings.map(RoomModel.Surface.init),
                floors: room.floors.map(RoomModel.Surface.init),
                objects: room.objects.map(RoomModel.Object.init)
            )
        } else {
            throw NSError(domain: "RoomScanner", code: 1, userInfo: [NSLocalizedDescriptionKey: "No room scanned"])
        }
        return try JSONEncoder().encode(model)
    }

    // ── RoomCaptureSessionDelegate (may arrive off the main thread) ──────────
    func captureSession(_ session: RoomCaptureSession, didUpdate room: CapturedRoom) {
        let text = "\(room.walls.count) walls · \(room.doors.count) doors · \(room.windows.count) windows · \(room.objects.count) objects"
        let walls = room.walls.map(Self.segment)
        let openings = (room.doors + room.windows + room.openings).map(Self.segment)
        DispatchQueue.main.async {
            self.liveSummary = text
            self.planWalls = self.finishedPlanWalls + walls
            self.planOpenings = openings
            self.onRoomUpdate?(room)
        }
    }

    /// A vertical surface seen from above: its centre ± half its width along local X.
    private static func segment(_ s: CapturedRoom.Surface) -> PlanSegment {
        let c = s.transform.columns.3, x = s.transform.columns.0
        let half = SIMD2(x.x, x.z) * (s.dimensions.x / 2)
        let centre = SIMD2(c.x, c.z)
        return PlanSegment(a: centre - half, b: centre + half)
    }

    func captureSession(_ session: RoomCaptureSession, didProvide instruction: RoomCaptureSession.Instruction) {
        let text: String
        switch instruction {
        case .moveCloseToWall: text = "Move closer to the wall"
        case .moveAwayFromWall: text = "Move away from the wall"
        case .slowDown: text = "Slow down"
        case .turnOnLight: text = "Turn on more light"
        case .lowTexture: text = "Low texture — aim at furniture or edges"
        default: text = ""
        }
        DispatchQueue.main.async { self.instruction = text }
    }

    func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
        if let error {
            DispatchQueue.main.async { self.state = .failed(error.localizedDescription) }
            return
        }
        Task {
            do {
                let room = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
                await MainActor.run {
                    self.rooms.append(room)
                    self.roomsCaptured = self.rooms.count
                    self.finishedPlanWalls += room.walls.map(Self.segment)
                    self.state = .roomReady
                }
            } catch {
                await MainActor.run { self.state = .failed(error.localizedDescription) }
            }
        }
    }
}

/// Compact, renderer-friendly room model. All transforms are 4×4 column-major
/// (three.js `Matrix4.fromArray` order) in the ARWorldMap frame.
struct RoomModel: Encodable {
    var version = 1
    let rooms: Int
    let walls: [Surface]
    let doors: [Surface]
    let windows: [Surface]
    let openings: [Surface]
    let floors: [Surface]
    let objects: [Object]

    struct Surface: Encodable {
        let category: String
        let isOpen: Bool?
        /// width (local X), height (local Y), thickness (local Z, usually 0).
        let dimensions: [Float]
        let transform: [Float]
        /// Outline in the surface's local frame (used for floors).
        let polygon: [[Float]]
        let story: Int

        init(_ s: CapturedRoom.Surface) {
            switch s.category {
            case .wall: category = "wall"; isOpen = nil
            case .door(let open): category = "door"; isOpen = open
            case .window: category = "window"; isOpen = nil
            case .opening: category = "opening"; isOpen = nil
            case .floor: category = "floor"; isOpen = nil
            @unknown default: category = "unknown"; isOpen = nil
            }
            dimensions = [s.dimensions.x, s.dimensions.y, s.dimensions.z]
            transform = s.transform.columnMajor
            polygon = s.polygonCorners.map { [$0.x, $0.y, $0.z] }
            story = s.story
        }
    }

    struct Object: Encodable {
        let category: String
        let dimensions: [Float]
        let transform: [Float]

        init(_ o: CapturedRoom.Object) {
            category = String(describing: o.category)
            dimensions = [o.dimensions.x, o.dimensions.y, o.dimensions.z]
            transform = o.transform.columnMajor
        }
    }
}

extension simd_float4x4 {
    var columnMajor: [Float] {
        [columns.0, columns.1, columns.2, columns.3].flatMap { [$0.x, $0.y, $0.z, $0.w] }
    }
}
