import ARKit
import SceneKit
import SwiftUI

@main
struct XenonObserverApp: App {
    @StateObject private var observer = ObserverController()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(observer)
                .preferredColorScheme(.dark)
                .tint(Theme.blaze)
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var observer: ObserverController
    @State private var showSettings = false

    var body: some View {
        ZStack {
            GeometryReader { geo in
                ZStack {
                    ARCameraView(session: observer.session, scene: observer.overlay.scene)
                    SkeletonOverlay(skeletons: observer.overlayJoints)
                    LinearGradient(colors: [.black.opacity(0.65), .clear, .clear, .black.opacity(0.75)],
                                   startPoint: .top, endPoint: .bottom)
                        .allowsHitTesting(false)
                    HUDFrame().padding(.top, 120).padding(.bottom, 12)
                }
                .onAppear { observer.viewportSize = geo.size }
                .onChange(of: geo.size) { _, size in observer.viewportSize = size }
            }
            .ignoresSafeArea()

            VStack(spacing: 10) {
                header
                Spacer()
                controls
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
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
        case .connected: Theme.live
        case .connecting: Theme.blaze2
        case .disconnected: Theme.blaze
        }
    }

    private var tracking: Bool { observer.trackingText == "Tracking" }

    private var header: some View {
        VStack(spacing: 8) {
            HStack(spacing: 10) {
                XenonMark().frame(width: 32, height: 32)
                Text("Xenon")
                    .font(Theme.sans(20, .heavy))
                    .foregroundStyle(Theme.text)
                Spacer(minLength: 4)
                Button { observer.relay.reconnect() } label: {
                    HStack(spacing: 7) {
                        LED(color: hubColor)
                        Text(observer.relay.state == .connected ? "HUB LINK" : observer.relay.state.rawValue.uppercased())
                            .font(Theme.mono(11, .semibold))
                            .tracking(0.8)
                    }
                    .foregroundStyle(hubColor)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .glass(17)
                }
                Button { showSettings = true } label: {
                    Image(systemName: "slider.horizontal.3")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(Theme.text)
                        .frame(width: 34, height: 34)
                        .glass(17)
                }
            }
            // Ticker-style status strip, like the landing page.
            HStack(spacing: 10) {
                Text(modeName)
                    .font(Theme.sans(11, .heavy))
                    .tracking(1.6)
                    .foregroundStyle(.black)
                    .padding(.horizontal, 11)
                    .frame(height: 26)
                    .background(Capsule().fill(modeColor))
                HStack(spacing: 6) {
                    Text("✕").foregroundStyle(Theme.blaze).font(.system(size: 9, weight: .bold))
                    Text(observer.hubHost.isEmpty ? "No hub set" : observer.hubHost).foregroundStyle(Theme.text)
                    Text("✕").foregroundStyle(Theme.blaze).font(.system(size: 9, weight: .bold))
                    Text(observer.trackingText).foregroundStyle(tracking ? Theme.muted : Theme.blaze2)
                }
                .font(Theme.sans(12, .medium))
                .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, 4)
            .padding(.trailing, 12)
            .frame(height: 34)
            .glass(17)
        }
    }

    private var modeName: String {
        switch observer.mode {
        case .scanning: "SCAN"
        case .sharedMap: "LIVE"
        case .calibratedRoom: observer.calibrated ? "LIVE" : "CALIBRATE"
        case .relocalizing: "RELOC"
        }
    }

    private var modeColor: Color {
        switch observer.mode {
        case .sharedMap: Theme.blaze
        case .calibratedRoom: observer.calibrated ? Theme.blaze : Theme.text
        case .scanning: Theme.sky
        case .relocalizing: Theme.blaze2
        }
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                LED(color: observer.relay.state == .connected ? Theme.live : Theme.blaze)
                Text(observer.status)
                    .font(Theme.mono(11, .medium))
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if observer.mode == .scanning {
                scanPanel
            } else {
                telemetry
                modeButtons
            }
        }
        .padding(14)
        .glass(26)
        .disabled(observer.busy)
        .overlay { if observer.busy { ProgressView().tint(Theme.blaze) } }
    }

    private var telemetry: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                SectionLabel(text: "Contacts")
                Spacer()
                Tag(text: observer.overlayJoints.isEmpty ? "No contact" : "Visual",
                    color: observer.overlayJoints.isEmpty ? Theme.dim : Theme.blaze,
                    solid: !observer.overlayJoints.isEmpty)
            }
            Text(observer.targetText)
                .font(Theme.sans(17, observer.overlayJoints.isEmpty ? .light : .bold))
                .foregroundStyle(observer.overlayJoints.isEmpty ? Theme.muted : Theme.text)
            Text(observer.poseText)
                .font(Theme.mono(10))
                .foregroundStyle(Theme.dim)
            if observer.mode == .sharedMap && !observer.remoteText.isEmpty {
                let hidden = observer.remoteText.contains("behind")
                HStack(spacing: 10) {
                    Text(hidden ? "!" : "●")
                        .font(.system(size: 12, weight: .heavy))
                        .foregroundStyle(.black)
                        .frame(width: 24, height: 24)
                        .background(RoundedRectangle(cornerRadius: 7).fill(hidden ? Theme.blaze : Theme.live))
                    Text(observer.remoteText.uppercased())
                        .font(Theme.mono(11, .semibold))
                        .foregroundStyle(hidden ? Theme.blaze2 : Theme.text)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 14).fill((hidden ? Theme.blaze : Theme.live).opacity(0.12)))
                .overlay(RoundedRectangle(cornerRadius: 14).stroke((hidden ? Theme.blaze : Theme.live).opacity(0.45), lineWidth: 1))
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 18).fill(Theme.fill))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Theme.stroke, lineWidth: 1))
    }

    @ViewBuilder
    private var modeButtons: some View {
        HStack(spacing: 8) {
            Button { observer.joinSharedMap() } label: {
                Label(observer.mode == .sharedMap ? "Re-join map" : "Join map", systemImage: "map")
            }
            .buttonStyle(TacticalButtonStyle(tint: Theme.text))
            if RoomScanner.isSupported {
                Button { observer.startScan() } label: {
                    Label("Scan", systemImage: "cube.transparent")
                }
                .buttonStyle(TacticalButtonStyle(tint: Theme.text))
            }
        }
        if observer.mode != .calibratedRoom {
            HStack(spacing: 8) {
                Button(observer.showRoomWalls ? "Walls on" : "Walls off") { observer.showRoomWalls.toggle() }
                    .buttonStyle(TacticalButtonStyle(tint: observer.showRoomWalls ? Theme.sky : Theme.dim))
                Button("Leave map") { observer.leaveSharedMap() }
                    .buttonStyle(TacticalButtonStyle(tint: Theme.blaze))
            }
        }
        Button {
            observer.calibrate()
        } label: {
            HStack(spacing: 10) {
                Text(calibrateTitle)
                Spacer(minLength: 0)
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(.black)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Theme.blaze))
            }
            .padding(.leading, 8)
            .padding(.vertical, -6)
            .padding(.trailing, -6)
        }
        .buttonStyle(TacticalButtonStyle(tint: Theme.text, filled: true))
    }

    private var calibrateTitle: String {
        if observer.mode != .calibratedRoom { return "Leave map & calibrate here" }
        return observer.calibrated ? "Calibrated — recalibrate" : "Calibrate beside laptop"
    }

    @ViewBuilder
    private var scanPanel: some View {
        let scanner = observer.scanner
        HStack(alignment: .top, spacing: 12) {
            ScanPlanView(walls: scanner.planWalls, openings: scanner.planOpenings, pose: observer.planPose)
                .frame(width: 130, height: 130)
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel(text: "Structure capture")
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("\(scanner.roomsCaptured)").font(Theme.sans(30, .heavy)).foregroundStyle(Theme.text)
                    Text("ROOMS").font(Theme.mono(10, .semibold)).foregroundStyle(Theme.dim)
                }
                Text("Walls draw in AR as they are captured. Cover every wall and corner.")
                    .font(Theme.sans(12))
                    .foregroundStyle(Theme.muted)
                if !scanner.liveSummary.isEmpty {
                    Text(scanner.liveSummary).font(Theme.mono(10, .semibold)).foregroundStyle(Theme.sky)
                }
            }
        }
        if !scanner.instruction.isEmpty {
            Tag(text: scanner.instruction, color: Theme.blaze)
        }
        switch scanner.state {
        case .scanning:
            scanButton("Finish this room", tint: Theme.text) { observer.finishRoom() }
        case .processing:
            ProgressView("Processing room…").font(Theme.mono(11)).tint(Theme.blaze)
        case .roomReady:
            HStack(spacing: 8) {
                Button("Next room") { observer.nextRoom() }
                    .buttonStyle(TacticalButtonStyle(tint: Theme.text))
                scanButton("Save & share", tint: Theme.blaze) { observer.uploadScan() }
            }
        case .failed(let message):
            Text(message).font(Theme.mono(11, .semibold)).foregroundStyle(Theme.blaze2)
            scanButton("Try again", tint: Theme.blaze) { observer.cancelScan(); observer.startScan() }
        case .idle:
            EmptyView()
        }
        Button("Abort scan") { observer.cancelScan() }
            .buttonStyle(TacticalButtonStyle(tint: Theme.blaze))
    }

    private func scanButton(_ title: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(TacticalButtonStyle(tint: tint, filled: true))
    }
}

/// The Xenon mark: blaze rounded square with a black ✕ (same as the web favicon).
struct XenonMark: View {
    var body: some View {
        GeometryReader { geo in
            let s = geo.size.width
            ZStack {
                RoundedRectangle(cornerRadius: s * 0.3, style: .continuous).fill(Theme.blaze)
                Path { p in
                    p.move(to: CGPoint(x: s * 0.3, y: s * 0.3)); p.addLine(to: CGPoint(x: s * 0.7, y: s * 0.7))
                    p.move(to: CGPoint(x: s * 0.7, y: s * 0.3)); p.addLine(to: CGPoint(x: s * 0.3, y: s * 0.7))
                }
                .stroke(Color.black, lineWidth: s * 0.11)
            }
        }
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
                context.draw(Text("Acquiring…").font(Theme.mono(9)).foregroundColor(Theme.muted),
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
            for (segments, color, width) in [(walls, Theme.steel, 3.0), (openings, Theme.blaze2, 4.0)] {
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
                context.stroke(arrow, with: .color(Theme.blaze), lineWidth: 2)
                context.fill(Path(ellipseIn: CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)), with: .color(Theme.blaze))
            }
        }
        .background {
            // Faint 10-cell grid, like a plan view.
            Canvas { context, size in
                var grid = Path()
                for i in 1..<10 {
                    let x = size.width * CGFloat(i) / 10, y = size.height * CGFloat(i) / 10
                    grid.move(to: CGPoint(x: x, y: 0)); grid.addLine(to: CGPoint(x: x, y: size.height))
                    grid.move(to: CGPoint(x: 0, y: y)); grid.addLine(to: CGPoint(x: size.width, y: y))
                }
                context.stroke(grid, with: .color(Theme.stroke), lineWidth: 0.5)
            }
            .background(Color.black.opacity(0.6))
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(Theme.stroke2, lineWidth: 1))
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

private let personColors: [Color] = Theme.tracks

struct SkeletonOverlay: View {
    let skeletons: [[OverlayJoint]]

    private static let links: [(String, String)] = [
        ("left_ear", "left_eye"), ("left_eye", "nose"), ("nose", "right_eye"), ("right_eye", "right_ear"),
        ("nose", "neck"), ("neck", "left_shoulder"), ("neck", "right_shoulder"), ("neck", "root"),
        ("root", "left_hip"), ("root", "right_hip"),
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
        context.stroke(path, with: .color(color), lineWidth: 2.5)
        for joint in joints {
            let r: CGFloat = 4.5
            let dot = Path(ellipseIn: CGRect(x: joint.point.x - r, y: joint.point.y - r, width: 2 * r, height: 2 * r))
            // Hollow dot = no LiDAR depth at that joint (not sent to the hub).
            if joint.hasDepth {
                context.fill(dot, with: .color(color))
            } else {
                context.stroke(dot, with: .color(Theme.blaze), lineWidth: 2)
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
                    Text("Hub address").font(Theme.mono(11, .semibold))
                } footer: {
                    Text("The laptop's Wi-Fi IP (Linux: `ip -4 addr`). Phone and laptop must be on the same network. Test it by opening http://\(host.isEmpty ? "<ip>" : host):\(port)/health in Safari.")
                }
                Section {
                    TextField("Phone-A", text: $name)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                } header: {
                    Text("Asset callsign").font(Theme.mono(11, .semibold))
                } footer: {
                    Text("Shown on the laptop's 3D view. Use a different name on each phone.")
                }
            }
            .navigationTitle("XENON // CONFIG")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Connect") { onSave(host, port, name) }
                        .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
