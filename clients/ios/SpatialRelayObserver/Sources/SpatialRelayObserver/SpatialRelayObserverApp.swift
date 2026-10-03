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
                    ARCameraView(session: observer.session)
                    SkeletonOverlay(skeletons: observer.overlay)
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
            SettingsView(host: observer.hubHost, port: observer.hubPort) { host, port in
                observer.saveSettings(host: host, port: port)
                showSettings = false
            }
            .presentationDetents([.medium])
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
            Text(observer.targetText)
                .font(.caption.monospaced())
                .foregroundStyle(observer.overlay.isEmpty ? Color.secondary : lime)
            Text(observer.poseText)
                .font(.caption.monospaced())
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
        }
        .padding(14)
        .background(.black.opacity(0.7))
    }
}

/// Renders the ARKit camera feed for an externally owned session.
struct ARCameraView: UIViewRepresentable {
    let session: ARSession

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
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
    let onSave: (String, Int) -> Void

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
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save & Connect") { onSave(host, port) }
                        .disabled(host.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}
