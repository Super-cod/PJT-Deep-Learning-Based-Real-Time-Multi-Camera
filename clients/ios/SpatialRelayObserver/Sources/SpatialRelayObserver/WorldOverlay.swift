import RoomPlan
import SceneKit
import UIKit
import simd

/// 3D content drawn into the AR camera view, in ARKit world coordinates.
///
/// * **Remote people** — people the *other* phones see, from the hub's fused
///   `world` packet. Drawn "x-ray" style (on top of everything), so a person
///   behind a real wall shows through it. Labels say who sees them, how far
///   away they are, and whether a scanned wall is in between.
/// * **Other phones** — small markers with names.
/// * **Room walls** — the shared scan, faint, for context and wall tests.
/// * **Live scan** — surfaces RoomPlan has captured so far, while scanning.
final class WorldOverlay {
    let scene = SCNScene()

    private let roomNode = SCNNode()
    private let scanNode = SCNNode()
    private let peopleNode = SCNNode()
    private let devicesNode = SCNNode()
    private var people: [String: PersonNode] = [:]
    private var devices: [String: SCNNode] = [:]
    private var lastScanRender: CFTimeInterval = 0

    private static let wallMask = 2
    private static let colors: [UIColor] = [
        UIColor(red: 0.73, green: 0.98, blue: 0.35, alpha: 1), .cyan, .orange, .purple, .yellow, .systemPink,
    ]
    private static let links: [(String, String)] = [
        ("nose", "left_shoulder"), ("nose", "right_shoulder"),
        ("left_shoulder", "right_shoulder"),
        ("left_shoulder", "left_elbow"), ("left_elbow", "left_wrist"),
        ("right_shoulder", "right_elbow"), ("right_elbow", "right_wrist"),
        ("left_shoulder", "left_hip"), ("right_shoulder", "right_hip"),
        ("left_hip", "right_hip"),
        ("left_hip", "left_knee"), ("left_knee", "left_ankle"),
        ("right_hip", "right_knee"), ("right_knee", "right_ankle"),
    ]

    var showRoomWalls = true {
        didSet { roomNode.opacity = showRoomWalls ? 1 : 0.001 } // near-0, not hidden: walls still block rays
    }

    init() {
        [roomNode, scanNode, peopleNode, devicesNode].forEach { scene.rootNode.addChildNode($0) }
    }

    // ── Shared room walls ────────────────────────────────────────────────────
    func setRoom(_ room: RoomResponse.Room) {
        roomNode.childNodes.forEach { $0.removeFromParentNode() }
        for wall in room.walls {
            roomNode.addChildNode(surfaceNode(dimensions: wall.dimensions.vec3, transform: Self.matrix(wall.transform),
                                              color: .white, alpha: 0.12, isWall: true))
        }
        for door in room.doors ?? [] {
            roomNode.addChildNode(surfaceNode(dimensions: door.dimensions.vec3, transform: Self.matrix(door.transform),
                                              color: .orange, alpha: 0.18, isWall: false))
        }
    }

    // ── Live scan (RoomPlan didUpdate) ───────────────────────────────────────
    func showScan(_ room: CapturedRoom) {
        let now = CACurrentMediaTime()
        guard now - lastScanRender > 0.25 else { return } // ≤ 4 rebuilds / s
        lastScanRender = now
        scanNode.childNodes.forEach { $0.removeFromParentNode() }
        let groups: [([CapturedRoom.Surface], UIColor, Float)] = [
            (room.walls, .cyan, 0.30), (room.doors, .orange, 0.55), (room.windows, .systemBlue, 0.55), (room.openings, .green, 0.4),
        ]
        for (surfaces, color, alpha) in groups {
            for s in surfaces {
                scanNode.addChildNode(surfaceNode(dimensions: s.dimensions, transform: s.transform, color: color, alpha: CGFloat(alpha), isWall: false))
            }
        }
        for object in room.objects {
            scanNode.addChildNode(boxNode(size: object.dimensions, transform: object.transform, color: .lightGray, alpha: 0.35))
        }
    }

    func clearScan() {
        scanNode.childNodes.forEach { $0.removeFromParentNode() }
    }

    // ── Remote people + phones (hub world packet) ───────────────────────────
    /// Returns how many remote people are shown and how many of them are behind a wall.
    @discardableResult
    func update(world: WorldPacket, myDeviceId: String, cameraPosition: SIMD3<Float>) -> (shown: Int, hidden: Int) {
        let names = Dictionary(world.devices.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })

        // People this phone already sees are drawn by the 2D overlay; show the rest.
        let remote = world.people.filter { !$0.seenBy.contains(myDeviceId) }
        var keep = Set<String>()
        var hidden = 0
        for (index, person) in remote.enumerated() {
            keep.insert(person.id)
            let node = people[person.id] ?? {
                let n = PersonNode(color: Self.colors[Self.colorIndex(person.id, fallback: index)])
                people[person.id] = n
                peopleNode.addChildNode(n.root)
                return n
            }()
            node.update(joints: person.joints, links: Self.links)

            let chest = person.position.vec3 + SIMD3(0, 0.35, 0)
            // 0.5 m steps: the label texture is only redrawn when its text changes.
            let distance = (simd_distance(cameraPosition, chest) * 2).rounded() / 2
            let behindWall = wallBetween(cameraPosition, chest)
            if behindWall { hidden += 1 }
            let seers = person.seenBy.map { names[$0] ?? $0 }.joined(separator: ", ")
            node.setLabel(String(format: "%@ · %.1f m%@\nvia %@", person.id, distance, behindWall ? " · BEHIND WALL" : "", seers),
                          warning: behindWall)
        }
        for (id, node) in people where !keep.contains(id) {
            node.root.removeFromParentNode()
            people[id] = nil
        }

        // Other phones.
        var keepDevices = Set<String>()
        for device in world.devices where device.id != myDeviceId && device.online {
            keepDevices.insert(device.id)
            let node = devices[device.id] ?? {
                let n = Self.deviceMarker(name: device.name)
                devices[device.id] = n
                devicesNode.addChildNode(n)
                return n
            }()
            node.simdPosition = device.position.vec3
            if device.quaternionXyzw.count == 4 {
                let q = device.quaternionXyzw
                node.simdOrientation = simd_quatf(ix: q[0], iy: q[1], iz: q[2], r: q[3])
            }
        }
        for (id, node) in devices where !keepDevices.contains(id) {
            node.removeFromParentNode()
            devices[id] = nil
        }
        return (remote.count, hidden)
    }

    func clearWorld() {
        people.values.forEach { $0.root.removeFromParentNode() }
        people.removeAll()
        devices.values.forEach { $0.removeFromParentNode() }
        devices.removeAll()
    }

    /// Does a scanned wall block the line between two world points?
    private func wallBetween(_ a: SIMD3<Float>, _ b: SIMD3<Float>) -> Bool {
        guard !roomNode.childNodes.isEmpty else { return false }
        // Stop short of the person so the wall they lean against doesn't count.
        let end = b + simd_normalize(a - b) * 0.25
        let hits = scene.rootNode.hitTestWithSegment(
            from: SCNVector3(a), to: SCNVector3(end),
            options: [SCNHitTestOption.categoryBitMask.rawValue: Self.wallMask,
                      SCNHitTestOption.backFaceCulling.rawValue: false,
                      SCNHitTestOption.ignoreHiddenNodes.rawValue: false]
        )
        return !hits.isEmpty
    }

    // ── Node builders ────────────────────────────────────────────────────────
    private func surfaceNode(dimensions d: SIMD3<Float>, transform: simd_float4x4, color: UIColor, alpha: CGFloat, isWall: Bool) -> SCNNode {
        let node = boxNode(size: SIMD3(d.x, d.y, max(d.z, 0.04)), transform: transform, color: color, alpha: alpha)
        if isWall { node.categoryBitMask = Self.wallMask }
        return node
    }

    private func boxNode(size: SIMD3<Float>, transform: simd_float4x4, color: UIColor, alpha: CGFloat) -> SCNNode {
        let box = SCNBox(width: CGFloat(max(size.x, 0.01)), height: CGFloat(max(size.y, 0.01)),
                         length: CGFloat(max(size.z, 0.01)), chamferRadius: 0)
        let material = SCNMaterial()
        material.diffuse.contents = color.withAlphaComponent(alpha)
        material.lightingModel = .constant
        material.isDoubleSided = true
        material.writesToDepthBuffer = false
        box.materials = [material]
        let node = SCNNode(geometry: box)
        node.simdTransform = transform
        return node
    }

    private static func deviceMarker(name: String) -> SCNNode {
        let node = SCNNode()
        let body = SCNNode(geometry: SCNBox(width: 0.08, height: 0.16, length: 0.015, chamferRadius: 0.01))
        body.geometry?.materials = [xray(.systemPink)]
        body.renderingOrder = 50
        node.addChildNode(body)
        let label = labelNode(name, color: .systemPink)
        label.simdPosition = SIMD3(0, 0.2, 0)
        node.addChildNode(label)
        return node
    }

    static func xray(_ color: UIColor) -> SCNMaterial {
        let m = SCNMaterial()
        m.diffuse.contents = color
        m.emission.contents = color
        m.lightingModel = .constant
        m.readsFromDepthBuffer = false // always visible: "see through" walls
        m.writesToDepthBuffer = false
        return m
    }

    static func labelNode(_ text: String, color: UIColor) -> SCNNode {
        let image = labelImage(text, color: color)
        let height: CGFloat = 0.09 * CGFloat(text.split(separator: "\n").count)
        let plane = SCNPlane(width: height * image.size.width / image.size.height, height: height)
        let material = SCNMaterial()
        material.diffuse.contents = image
        material.lightingModel = .constant
        material.readsFromDepthBuffer = false
        material.writesToDepthBuffer = false
        material.isDoubleSided = true
        plane.materials = [material]
        let node = SCNNode(geometry: plane)
        node.constraints = [SCNBillboardConstraint()]
        node.renderingOrder = 100
        return node
    }

    private static func labelImage(_ text: String, color: UIColor) -> UIImage {
        let font = UIFont.monospacedSystemFont(ofSize: 34, weight: .semibold)
        let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let size = (text as NSString).boundingRect(with: CGSize(width: 2000, height: 400), options: .usesLineFragmentOrigin,
                                                   attributes: attributes, context: nil).size
        let canvas = CGSize(width: ceil(size.width) + 28, height: ceil(size.height) + 16)
        return UIGraphicsImageRenderer(size: canvas).image { ctx in
            UIColor(white: 0.03, alpha: 0.78).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: canvas), cornerRadius: 12).fill()
            (text as NSString).draw(with: CGRect(x: 14, y: 8, width: size.width, height: size.height),
                                    options: .usesLineFragmentOrigin, attributes: attributes, context: nil)
        }
    }

    private static func matrix(_ a: [Float]) -> simd_float4x4 {
        guard a.count == 16 else { return matrix_identity_float4x4 }
        return simd_float4x4(columns: (SIMD4(a[0], a[1], a[2], a[3]), SIMD4(a[4], a[5], a[6], a[7]),
                                       SIMD4(a[8], a[9], a[10], a[11]), SIMD4(a[12], a[13], a[14], a[15])))
    }

    private static func colorIndex(_ id: String, fallback: Int) -> Int {
        let digits = id.filter(\.isNumber)
        return ((Int(digits) ?? (fallback + 1)) - 1 + colors.count) % colors.count
    }
}

/// A remote person's skeleton: joint spheres + bone cylinders + a label.
private final class PersonNode {
    let root = SCNNode()
    private var joints: [String: SCNNode] = [:]
    private var bones: [String: SCNNode] = [:]
    private let ring: SCNNode
    private var label: SCNNode?
    private var labelText = ""
    private let color: UIColor
    private let material: SCNMaterial

    init(color: UIColor) {
        self.color = color
        material = WorldOverlay.xray(color)
        let torus = SCNTorus(ringRadius: 0.25, pipeRadius: 0.012)
        torus.materials = [material]
        ring = SCNNode(geometry: torus)
        ring.renderingOrder = 60
        root.addChildNode(ring)
    }

    func update(joints list: [WorldPacket.Joint], links: [(String, String)]) {
        var positions: [String: SIMD3<Float>] = [:]
        for joint in list {
            let p = joint.position.vec3
            positions[joint.name] = p
            let node = joints[joint.name] ?? {
                let sphere = SCNSphere(radius: 0.04)
                sphere.materials = [material]
                let n = SCNNode(geometry: sphere)
                n.renderingOrder = 60
                joints[joint.name] = n
                root.addChildNode(n)
                return n
            }()
            node.simdPosition = p
        }
        for (name, node) in joints where positions[name] == nil { node.removeFromParentNode(); joints[name] = nil }

        for (a, b) in links {
            let key = a + "|" + b
            guard let pa = positions[a], let pb = positions[b], simd_distance(pa, pb) > 0.01 else {
                bones[key]?.removeFromParentNode()
                bones[key] = nil
                continue
            }
            let node = bones[key] ?? {
                let cylinder = SCNCylinder(radius: 0.015, height: 1)
                cylinder.materials = [material]
                let n = SCNNode(geometry: cylinder)
                n.renderingOrder = 60
                bones[key] = n
                root.addChildNode(n)
                return n
            }()
            (node.geometry as? SCNCylinder)?.height = CGFloat(simd_distance(pa, pb))
            node.simdPosition = (pa + pb) / 2
            node.simdOrientation = simd_quatf(from: SIMD3(0, 1, 0), to: simd_normalize(pb - pa))
        }

        let feet = [positions["left_ankle"], positions["right_ankle"]].compactMap { $0 }
        let hips = [positions["left_hip"], positions["right_hip"]].compactMap { $0 }
        let base = feet.isEmpty ? (hips.first ?? .zero) - SIMD3(0, 0.9, 0) : feet.reduce(.zero, +) / Float(feet.count)
        ring.simdPosition = base
        let top = positions["nose"] ?? base + SIMD3(0, 1.7, 0)
        label?.simdPosition = top + SIMD3(0, 0.3, 0)
    }

    func setLabel(_ text: String, warning: Bool) {
        guard text != labelText else { return }
        labelText = text
        let position = label?.simdPosition
        label?.removeFromParentNode()
        let node = WorldOverlay.labelNode(text, color: warning ? .orange : color)
        if let position { node.simdPosition = position }
        label = node
        root.addChildNode(node)
    }
}
