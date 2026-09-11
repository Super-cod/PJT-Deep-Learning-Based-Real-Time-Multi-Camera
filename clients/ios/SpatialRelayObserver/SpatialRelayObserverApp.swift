import SwiftUI

@main struct SpatialRelayObserverApp: App {
    @StateObject private var observer = ObserverController()
    var body: some Scene { WindowGroup { ContentView().environmentObject(observer) } }
}

struct ContentView: View {
    @EnvironmentObject var observer: ObserverController
    var body: some View {
        VStack(spacing: 18) {
            Text("Spatial Relay").font(.largeTitle.bold())
            Text(observer.status).foregroundStyle(.secondary)
            Text(observer.poseText).font(.system(.body, design: .monospaced))
            Button(observer.calibrated ? "Calibrated" : "Calibrate at laptop") { observer.calibrate() }
                .buttonStyle(.borderedProminent).disabled(observer.calibrated || !observer.ready)
            Text("Align the rear camera with the laptop webcam, then calibrate. Keep the laptop fixed.")
                .font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }.padding().task { observer.start() }
    }
}
