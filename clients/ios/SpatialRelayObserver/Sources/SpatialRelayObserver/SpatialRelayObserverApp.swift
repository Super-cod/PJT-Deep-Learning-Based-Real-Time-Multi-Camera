import ARKit
import SceneKit
import SwiftUI

@main
struct SpatialRelayObserverApp: App {
    @StateObject private var observer = ObserverController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(observer)
                .preferredColorScheme(.dark)
        }
    }
}

private let lime = Color(red: 0.73, green: 0.98, blue: 0.35)

struct ContentView: View {
    @EnvironmentObject var observer: ObserverController
    @State private var showSettings = false

    var body: some View {
        ZStack {
            GeometryReader { geo in
                ZStack {
                    ARCameraView(session: observer.session, scene: observer.overlay.scene)
                    SkeletonOverlay(skeletons: observer.overlayJoints)
                }
                .onAppear { observer.viewportSize = geo.size }
                .onChange(of: geo.size) { _, size in observer.viewportSize = size }
            }
            .ignoresSafeArea()

            VStack(spacing: 0) {
                header
                Spacer()
                controls
            }
        }
        .sheet(isPresented: $showSettings) {
            SettingsView(host: observer.hubHost, port: observer.hubPort, name: observer.deviceName) { host, port, name in
                observer.saveSettings(host: host, port: port, name: name)
                showSettings = false
            }
            .presentationDetents([.medium, .large])
        }
        .task {
            observer.start()
            if observer.hubURL == nil { showSettings = true }
        }
    }

    private var hubColor: Color {
        switch observer.relay.state {
        case .connected: lime
        case .connecting: .orange
        case .disconnected: .red
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Button { observer.relay.reconnect() } label: {
                HStack(spacing: 6) {
                    Circle().fill(hubColor).frame(width: 8, height: 8)
                    Text(observer.relay.state == .connected ? "HUB" : observer.relay.state.rawValue.uppercased())
                        .font(.caption.monospaced().bold())
                        .foregroundStyle(hubColor)
                }
            }
            Text(observer.hubHost.isEmpty ? "no hub set" : observer.hubHost)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
            Spacer()
            Text(observer.trackingText)
                .font(.caption2)
                .foregroundStyle(observer.trackingText == "Tracking" ? lime : .orange)
            Button { showSettings = true } label: {
                Image(systemName: "gearshape").foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.black.opacity(0.6))
    }

    private var controls: some View {
        VStack(spacing: 10) {
            Text(observer.status)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            if observer.mode == .scanning {
                scanPanel
            } else {
                Text(observer.targetText)
                    .font(.caption.monospaced())
                    .foregroundStyle(observer.overlayJoints.isEmpty ? Color.secondary : lime)
                Text(observer.poseText)
                    .font(.caption.monospaced())
                modeButtons
            }
        }
        .padding(14)
        .background(.black.opacity(0.7))
        .disabled(observer.busy)
        .overlay { if observer.busy { ProgressView().tint(lime) } }
    }

    @ViewBuilder
    private var modeButtons: some View {
        HStack(spacing: 8) {
            Button { observer.joinSharedMap() } label: {
                Label(observer.mode == .sharedMap ? "Re-join map" : "Join shared map", systemImage: "map")
                    .font(.footnote.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
            }
            .buttonStyle(.bordered)
            .tint(lime)
            if RoomScanner.isSupported {
                Button { observer.startScan() } label: {
                    Label("Scan rooms", systemImage: "cube.transparent")
                        .font(.footnote.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.bordered)
                .tint(.cyan)
            }
        }
        if observer.mode == .calibratedRoom {
            Button {
                observer.calibrate()
            } label: {
                Text(observer.calibrated ? "✓ Calibrated — tap to recalibrate" : "Calibrate (beside laptop webcam)")
                    .font(.callout.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(observer.calibrated ? .gray : lime)
            .foregroundStyle(.black)
        } else {
            HStack {
                Text(observer.mode == .sharedMap ? "● SHARED MAP" : "◌ RELOCALIZING…")
                    .font(.caption.monospaced().bold())
                    .foregroundStyle(observer.mode == .sharedMap ? lime : .orange)
                Spacer()
                Toggle("Walls", isOn: $observer.showRoomWalls)
                    .toggleStyle(.button)
                    .font(.caption)
                    .tint(lime)
            }
            if observer.mode == .sharedMap && !observer.remoteText.isEmpty {
                Text(observer.remoteText)
                    .font(.caption.monospaced().bold())
                    .foregroundStyle(observer.remoteText.contains("behind") ? .orange : lime)
            }
        }
    }

    @ViewBuilder
    private var scanPanel: some View {
        let scanner = observer.scanner
        HStack(alignment: .top, spacing: 10) {
            ScanPlanView(walls: scanner.planWalls, openings: scanner.planOpenings, pose: observer.planPose)
                .frame(width: 130, height: 130)
            VStack(alignment: .leading, spacing: 4) {
                Text("Rooms captured: \(scanner.roomsCaptured)")
                    .font(.caption.monospaced().bold())
                Text("Walls appear in cyan as they are captured. Cover every wall and corner.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        if !scanner.liveSummary.isEmpty {
            Text(scanner.liveSummary).font(.caption.monospaced()).foregroundStyle(lime)
        }
        if !scanner.instruction.isEmpty {
            Text(scanner.instruction).font(.caption).foregroundStyle(.orange)
        }
        switch scanner.state {
        case .scanning:
            scanButton("Finish this room", tint: lime) { observer.finishRoom() }
        case .processing:
            ProgressView("Processing room…").tint(lime)
        case .roomReady:
            HStack(spacing: 8) {
                scanButton("Next room", tint: .cyan) { observer.nextRoom() }
                scanButton("Save & share", tint: lime) { observer.uploadScan() }
            }
        case .failed(let message):
            Text(message).font(.caption).foregroundStyle(.red)
            scanButton("Try again", tint: .orange) { observer.cancelScan(); observer.startScan() }
        case .idle:
            EmptyView()
        }
        Button("Cancel scan", role: .cancel) { observer.cancelScan() }
            .font(.footnote)
    }

    private func scanButton(_ title: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.callout.bold())
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
        .foregroundStyle(.black)
    }
}

/// Top-down floor plan of what RoomPlan has captured, with the phone's position.
struct ScanPlanView: View {
    let walls: [RoomScanner.PlanSegment]
    let openings: [RoomScanner.PlanSegment]
    /// x, z, heading (radians)
    let pose: SIMD3<Float>?

    var body: some View {
        Canvas { context, size in
            let points = (walls + openings).flatMap { [$0.a, $0.b] } + (pose.map { [SIMD2($0.x, $0.y)] } ?? [])
            guard !points.isEmpty else {
                context.draw(Text("scanning…").font(.caption2).foregroundColor(.secondary),
                             at: CGPoint(x: size.width / 2, y: size.height / 2))
                return
            }
            // Fit everything (with 0.5 m margin) into the square, +X right, +Z down.
            let minP = points.reduce(points[0]) { simd_min($0, $1) } - 0.5
            let maxP = points.reduce(points[0]) { simd_max($0, $1) } + 0.5
            let scale = Float(min(size.width, size.height)) / max(maxP.x - minP.x, maxP.y - minP.y, 1)
            func pt(_ p: SIMD2<Float>) -> CGPoint {
                CGPoint(x: CGFloat((p.x - minP.x) * scale), y: CGFloat((p.y - minP.y) * scale))
            }
            for (segments, color, width) in [(walls, Color.cyan, 3.0), (openings, Color.orange, 4.0)] {
                var path = Path()
                for s in segments { path.move(to: pt(s.a)); path.addLine(to: pt(s.b)) }
                context.stroke(path, with: .color(color), lineWidth: width)
            }
            if let pose {
                let c = pt(SIMD2(pose.x, pose.y))
                let dir = CGPoint(x: CGFloat(sin(pose.z)) * 14, y: -CGFloat(cos(pose.z)) * 14)
                var arrow = Path()
                arrow.move(to: c)
                arrow.addLine(to: CGPoint(x: c.x + dir.x, y: c.y + dir.y))
                context.stroke(arrow, with: .color(lime), lineWidth: 2)
                context.fill(Path(ellipseIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)), with: .color(lime))
            }
        }
        .background(Color.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.15)))
    }
}

/// Renders the ARKit camera feed for an externally owned session.
struct ARCameraView: UIViewRepresentable {
    let session: ARSession
    /// World-anchored 3D content (remote people, walls, live scan).
    let scene: SCNScene

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.scene = scene
        view.session = session
        view.automaticallyUpdatesLighting = false
        view.rendersCameraGrain = false
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}

private let personColors: [Color] = [lime, .cyan, .orange, .purple, .yellow, .pink]

struct SkeletonOverlay: View {
    let skeletons: [[OverlayJoint]]

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

    var body: some View {
        Canvas { context, _ in
            for (index, joints) in skeletons.enumerated() {
                draw(joints, color: personColors[index % personColors.count], in: &context)
            }
        }
        .allowsHitTesting(false)
    }

    private func draw(_ joints: [OverlayJoint], color: Color, in context: inout GraphicsContext) {
        let byName = Dictionary(joints.map { ($0.name, $0.point) }, uniquingKeysWith: { a, _ in a })
        var path = Path()
        for (a, b) in Self.links {
            guard let pa = byName[a], let pb = byName[b] else { continue }
            path.move(to: pa)
            path.addLine(to: pb)
        }
        context.stroke(path, with: .color(color), lineWidth: 3)
        for joint in joints {
            let r: CGFloat = 5
            let dot = Path(ellipseIn: CGRect(x: joint.point.x - r, y: joint.point.y - r, width: 2 * r, height: 2 * r))
            // Hollow dot = no LiDAR depth at that joint (not sent to the hub).
            if joint.hasDepth {
                context.fill(dot, with: .color(color))
            } else {
                context.stroke(dot, with: .color(.red), lineWidth: 2)
            }
        }
    }
}

struct SettingsView: View {
    @State var host: String
    @State var port: Int
    @State var name: String
    let onSave: (String, Int, String) -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("192.168.1.25", text: $host)
                        .keyboardType(.numbersAndPunctuation)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    TextField("8000", value: $port, format: .number.grouping(.never))
                        .keyboardType(.numberPad)
                        .font(.body.monospaced())
                } header: {
                    Text("Laptop hub address")
                } footer: {
                    Text("The laptop's Wi-Fi IP (Linux: `ip -4 addr`). Phone and laptop must be on the same network. Test it by opening http://\(host.isEmpty ? "<ip>" : host):\(port)/health in Safari.")
                }
                Section {
                    TextField("Phone-A", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("This phone's name")
                } footer: {
                    Text("Shown on the laptop's 3D view. Use a different name on each phone.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save & Connect") { onSave(host, port, name) }
                        .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
