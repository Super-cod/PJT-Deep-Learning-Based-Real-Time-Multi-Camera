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
                .tint(Theme.blue)
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
                    HUDFrame().padding(.top, 96).padding(.bottom, 8)
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
        case .connected: Theme.green
        case .connecting: Theme.amber
        case .disconnected: Theme.red
        }
    }

    private var tracking: Bool { observer.trackingText == "Tracking" }

    private var header: some View {
        VStack(spacing: 0) {
            Text("UNCLASSIFIED // XENON // \(observer.deviceName.uppercased())")
                .font(Theme.mono(9, .semibold))
                .tracking(1.6)
                .foregroundStyle(Color.white.opacity(0.92))
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 3)
                .background(Theme.classification)
            HStack(spacing: 10) {
                XenonMark().frame(width: 20, height: 20)
                Text("XENON")
                    .font(.system(size: 15, weight: .bold))
                    .tracking(4)
                    .foregroundStyle(Theme.text)
                Rectangle().fill(Theme.line2).frame(width: 1, height: 18)
                Button { observer.relay.reconnect() } label: {
                    HStack(spacing: 6) {
                        Rectangle().fill(hubColor).frame(width: 6, height: 6)
                        Text(observer.relay.state == .connected ? "HUB LINK" : observer.relay.state.rawValue.uppercased())
                            .font(Theme.mono(10, .semibold))
                            .tracking(1.2)
                    }
                    .foregroundStyle(hubColor)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .overlay(Rectangle().stroke(hubColor.opacity(0.5), lineWidth: 1))
                }
                Spacer(minLength: 4)
                Button { showSettings = true } label: {
                    Image(systemName: "slider.horizontal.3")
                        .foregroundStyle(Theme.muted)
                        .frame(width: 30, height: 26)
                        .overlay(Rectangle().stroke(Theme.line2, lineWidth: 1))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Theme.panel.opacity(0.94))
            HStack(spacing: 14) {
                kv("HUB", observer.hubHost.isEmpty ? "NOT SET" : observer.hubHost)
                kv("TRK", observer.trackingText.uppercased(), tracking ? Theme.green : Theme.amber)
                Spacer()
                kv("MODE", modeName, modeColor)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(Theme.panel.opacity(0.8))
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        }
    }

    private var modeName: String {
        switch observer.mode {
        case .scanning: "SCAN"
        case .sharedMap: "SHARED MAP"
        case .calibratedRoom: observer.calibrated ? "CALIBRATED" : "UNCALIBRATED"
        case .relocalizing: "RELOCALIZING"
        }
    }

    private var modeColor: Color {
        switch observer.mode {
        case .sharedMap: Theme.green
        case .calibratedRoom: observer.calibrated ? Theme.green : Theme.amber
        case .scanning: Theme.blue
        case .relocalizing: Theme.amber
        }
    }

    private func kv(_ key: String, _ value: String, _ color: Color = Theme.text) -> some View {
        HStack(spacing: 5) {
            Text(key).foregroundStyle(Theme.dim)
            Text(value).foregroundStyle(color).lineLimit(1)
        }
        .font(Theme.mono(10, .medium))
        .tracking(0.8)
    }

    private var controls: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 6) {
                Text("›").foregroundStyle(Theme.blue)
                Text(observer.status)
                    .foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(Theme.mono(11))
            if observer.mode == .scanning {
                scanPanel
            } else {
                telemetry
                modeButtons
            }
        }
        .padding(14)
        .background(Theme.panel.opacity(0.94))
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
        .disabled(observer.busy)
        .overlay { if observer.busy { ProgressView().tint(Theme.blue) } }
    }

    private var telemetry: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                SectionLabel(text: "Contacts")
                Spacer()
                Tag(text: observer.overlayJoints.isEmpty ? "No contact" : "Visual", color: observer.overlayJoints.isEmpty ? Theme.dim : Theme.amber)
            }
            Text(observer.targetText.uppercased())
                .font(Theme.mono(11, .semibold))
                .foregroundStyle(observer.overlayJoints.isEmpty ? Theme.muted : Theme.text)
            Text(observer.poseText)
                .font(Theme.mono(10))
                .foregroundStyle(Theme.muted)
            if observer.mode == .sharedMap && !observer.remoteText.isEmpty {
                let hidden = observer.remoteText.contains("behind")
                HStack(alignment: .top, spacing: 6) {
                    Text(hidden ? "▲" : "●").foregroundStyle(hidden ? Theme.red : Theme.green)
                    Text(observer.remoteText.uppercased()).foregroundStyle(hidden ? Theme.red : Theme.text)
                }
                .font(Theme.mono(10, .semibold))
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background((hidden ? Theme.red : Theme.green).opacity(0.08))
                .overlay(alignment: .leading) { Rectangle().fill(hidden ? Theme.red : Theme.green).frame(width: 2) }
            }
        }
        .padding(10)
        .background(Theme.panel2)
        .overlay(Rectangle().stroke(Theme.line, lineWidth: 1))
    }

    @ViewBuilder
    private var modeButtons: some View {
        HStack(spacing: 8) {
            Button { observer.joinSharedMap() } label: {
                Label(observer.mode == .sharedMap ? "Re-join map" : "Join map", systemImage: "map")
            }
            .buttonStyle(TacticalButtonStyle(tint: Theme.blue))
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
                .buttonStyle(TacticalButtonStyle(tint: observer.showRoomWalls ? Theme.blue : Theme.dim))
                Button("Leave map") { observer.leaveSharedMap() }
                    .buttonStyle(TacticalButtonStyle(tint: Theme.red))
            }
        }
        Button {
            observer.calibrate()
        } label: {
            Text(calibrateTitle)
        }
        .buttonStyle(TacticalButtonStyle(tint: observer.mode == .calibratedRoom && !observer.calibrated ? Theme.blue : Theme.steel,
                                         filled: observer.mode == .calibratedRoom && !observer.calibrated))
    }

    private var calibrateTitle: String {
        if observer.mode != .calibratedRoom { return "Leave map & calibrate here" }
        return observer.calibrated ? "✓ Calibrated — recalibrate" : "Calibrate (beside laptop webcam)"
    }

    @ViewBuilder
    private var scanPanel: some View {
        let scanner = observer.scanner
        HStack(alignment: .top, spacing: 10) {
            ScanPlanView(walls: scanner.planWalls, openings: scanner.planOpenings, pose: observer.planPose)
                .frame(width: 130, height: 130)
            VStack(alignment: .leading, spacing: 6) {
                SectionLabel(text: "Structure capture")
                HStack(spacing: 5) {
                    Text("ROOMS").foregroundStyle(Theme.dim)
                    Text("\(scanner.roomsCaptured)").foregroundStyle(Theme.text)
                }
                .font(Theme.mono(11, .semibold))
                Text("Walls draw in AR as they are captured. Cover every wall and corner.")
                    .font(Theme.mono(10))
                    .foregroundStyle(Theme.muted)
                if !scanner.liveSummary.isEmpty {
                    Text(scanner.liveSummary.uppercased()).font(Theme.mono(10, .semibold)).foregroundStyle(Theme.blue)
                }
            }
        }
        if !scanner.instruction.isEmpty {
            Text("▲ " + scanner.instruction.uppercased()).font(Theme.mono(10, .semibold)).foregroundStyle(Theme.amber)
        }
        switch scanner.state {
        case .scanning:
            scanButton("Finish this room", tint: Theme.blue) { observer.finishRoom() }
        case .processing:
            ProgressView("PROCESSING ROOM…").font(Theme.mono(10)).tint(Theme.blue)
        case .roomReady:
            HStack(spacing: 8) {
                Button("Next room") { observer.nextRoom() }
                    .buttonStyle(TacticalButtonStyle(tint: Theme.text))
                scanButton("Save & share", tint: Theme.blue) { observer.uploadScan() }
            }
        case .failed(let message):
            Text(message.uppercased()).font(Theme.mono(10, .semibold)).foregroundStyle(Theme.red)
            scanButton("Try again", tint: Theme.amber) { observer.cancelScan(); observer.startScan() }
        case .idle:
            EmptyView()
        }
        Button("Abort scan") { observer.cancelScan() }
            .buttonStyle(TacticalButtonStyle(tint: Theme.red))
    }

    private func scanButton(_ title: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(TacticalButtonStyle(tint: tint, filled: true))
    }
}

/// The Xenon hexagon mark.
struct XenonMark: View {
    var body: some View {
        Canvas { context, size in
            let w = size.width, h = size.height
            var hex = Path()
            hex.move(to: CGPoint(x: w / 2, y: 1))
            hex.addLine(to: CGPoint(x: w - 1, y: h * 0.27))
            hex.addLine(to: CGPoint(x: w - 1, y: h * 0.73))
            hex.addLine(to: CGPoint(x: w / 2, y: h - 1))
            hex.addLine(to: CGPoint(x: 1, y: h * 0.73))
            hex.addLine(to: CGPoint(x: 1, y: h * 0.27))
            hex.closeSubpath()
            context.stroke(hex, with: .color(Theme.blue), lineWidth: 1.8)
            var x = Path()
            x.move(to: CGPoint(x: w * 0.33, y: h * 0.33)); x.addLine(to: CGPoint(x: w * 0.67, y: h * 0.67))
            x.move(to: CGPoint(x: w * 0.67, y: h * 0.33)); x.addLine(to: CGPoint(x: w * 0.33, y: h * 0.67))
            context.stroke(x, with: .color(Theme.text), lineWidth: 1.8)
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
                context.draw(Text("ACQUIRING…").font(Theme.mono(9)).foregroundColor(Theme.muted),
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
            for (segments, color, width) in [(walls, Theme.steel, 3.0), (openings, Theme.amber, 4.0)] {
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
                context.stroke(arrow, with: .color(Theme.blue), lineWidth: 2)
                context.fill(Path(CGRect(x: c.x - 4, y: c.y - 4, width: 8, height: 8)), with: .color(Theme.blue))
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
                context.stroke(grid, with: .color(Theme.line), lineWidth: 0.5)
            }
            .background(Color.black.opacity(0.7))
        }
        .overlay(Rectangle().stroke(Theme.line2, lineWidth: 1))
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
            let dot = Path(CGRect(x: joint.point.x - r, y: joint.point.y - r, width: 2 * r, height: 2 * r))
            // Hollow dot = no LiDAR depth at that joint (not sent to the hub).
            if joint.hasDepth {
                context.fill(dot, with: .color(color))
            } else {
                context.stroke(dot, with: .color(Theme.red), lineWidth: 2)
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
