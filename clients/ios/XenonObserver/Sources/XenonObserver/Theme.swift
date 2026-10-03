import SwiftUI
import UIKit

/// Xenon's tactical palette: dark flat panels, friendly blue, amber/red alerts.
enum Theme {
    static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    static let uiBlue = rgb(0x4C90F0)
    static let uiAmber = rgb(0xEC9A3C)
    static let uiRed = rgb(0xE76A6E)
    static let uiGreen = rgb(0x32A467)
    static let uiSteel = rgb(0x8F99A8)
    /// Tracked people, warm tones (matches the web console).
    static let uiTracks: [UIColor] = [0xEC9A3C, 0xF0B726, 0xE76A6E, 0xD69FD6, 0x2EE6D6, 0x72CA9B].map(rgb)

    static let blue = Color(uiBlue)
    static let amber = Color(uiAmber)
    static let red = Color(uiRed)
    static let green = Color(uiGreen)
    static let steel = Color(uiSteel)
    static let text = Color(rgb(0xF6F7F9))
    static let muted = Color(rgb(0x8F99A8))
    static let dim = Color(rgb(0x5F6B7C))
    static let panel = Color(rgb(0x15191E))
    static let panel2 = Color(rgb(0x1C2127))
    static let line = Color(rgb(0x2F343C))
    static let line2 = Color(rgb(0x404854))
    static let classification = Color(rgb(0x1C6E42))
    static let tracks: [Color] = uiTracks.map { Color($0) }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

/// Square, bordered, monospaced uppercase button.
struct TacticalButtonStyle: ButtonStyle {
    var tint: Color = Theme.text
    var filled = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.mono(11, .semibold))
            .tracking(1.2)
            .textCase(.uppercase)
            .foregroundStyle(filled ? Color.black : tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 11)
            .padding(.horizontal, 8)
            .background(filled ? tint : tint.opacity(configuration.isPressed ? 0.22 : 0.08))
            .overlay(Rectangle().stroke(filled ? tint : tint.opacity(0.55), lineWidth: 1))
            .opacity(configuration.isPressed ? 0.75 : 1)
    }
}

/// Small bordered status tag, e.g. `ONLINE`, `OCCLUDED`.
struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text.uppercased())
            .font(Theme.mono(9, .semibold))
            .tracking(1.2)
            .foregroundStyle(color)
            .padding(.horizontal, 5)
            .padding(.vertical, 3)
            .overlay(Rectangle().stroke(color.opacity(0.8), lineWidth: 1))
    }
}

/// Section title with the blue tick.
struct SectionLabel: View {
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            Rectangle().fill(Theme.blue).frame(width: 2, height: 10)
            Text(text.uppercased())
                .font(Theme.mono(10, .semibold))
                .tracking(1.6)
                .foregroundStyle(Theme.muted)
        }
    }
}

/// Corner brackets + centre reticle over the camera feed.
struct HUDFrame: View {
    var body: some View {
        GeometryReader { geo in
            Canvas { context, size in
                let l: CGFloat = 22, inset: CGFloat = 14
                let color = Color.white.opacity(0.5)
                var path = Path()
                for (x, y, dx, dy) in [(inset, inset, 1.0, 1.0), (size.width - inset, inset, -1.0, 1.0),
                                       (inset, size.height - inset, 1.0, -1.0), (size.width - inset, size.height - inset, -1.0, -1.0)] {
                    path.move(to: CGPoint(x: x + dx * l, y: y))
                    path.addLine(to: CGPoint(x: x, y: y))
                    path.addLine(to: CGPoint(x: x, y: y + dy * l))
                }
                context.stroke(path, with: .color(color), lineWidth: 1.5)
                let c = CGPoint(x: size.width / 2, y: size.height / 2)
                var reticle = Path()
                for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
                    reticle.move(to: CGPoint(x: c.x + dx * 6, y: c.y + dy * 6))
                    reticle.addLine(to: CGPoint(x: c.x + dx * 16, y: c.y + dy * 16))
                }
                context.stroke(reticle, with: .color(color), lineWidth: 1)
            }
            .frame(width: geo.size.width, height: geo.size.height)
        }
        .allowsHitTesting(false)
    }
}
