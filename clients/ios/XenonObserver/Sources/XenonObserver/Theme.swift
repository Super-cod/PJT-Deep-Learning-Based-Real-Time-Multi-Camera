import SwiftUI
import UIKit

/// Xenon's palette, shared with the landing page and web console: black,
/// frosted glass, pill controls, blaze orange accent, signal-green "live".
enum Theme {
    static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }

    static let uiBlaze = rgb(0xFF4D1A)
    static let uiBlaze2 = rgb(0xFF7A4D)
    static let uiLive = rgb(0x7DFF5A)
    static let uiBone = rgb(0xF4F4F2)
    static let uiSteel = rgb(0xD9D9D4)
    static let uiSky = rgb(0x8AD4FF)
    /// Tracked people, hot tones (matches the web console).
    static let uiTracks: [UIColor] = [0xFF4D1A, 0xFFB020, 0xFF3D6E, 0xFF7A4D, 0xFFD166, 0xC9A7FF].map(rgb)

    static let blaze = Color(uiBlaze)
    static let blaze2 = Color(uiBlaze2)
    static let live = Color(uiLive)
    static let steel = Color(uiSteel)
    static let sky = Color(uiSky)
    static let text = Color(uiBone)
    static let muted = Color(uiBone).opacity(0.62)
    static let dim = Color(uiBone).opacity(0.38)
    static let stroke = Color.white.opacity(0.10)
    static let stroke2 = Color.white.opacity(0.18)
    static let fill = Color.white.opacity(0.05)
    static let tracks: [Color] = uiTracks.map { Color($0) }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    static func sans(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight)
    }
}

extension View {
    /// Frosted dark glass with a hairline border, like the landing page cards.
    func glass(_ radius: CGFloat = 22) -> some View {
        background(.ultraThinMaterial.opacity(0.9), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .background(Color.black.opacity(0.45), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).stroke(Theme.stroke, lineWidth: 1))
    }
}

/// Capsule button. `filled` = primary (bone with blaze arrow look), else glass pill.
struct TacticalButtonStyle: ButtonStyle {
    var tint: Color = Theme.text
    var filled = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.sans(14, .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.8)
            .foregroundStyle(filled ? Color.black : tint)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .padding(.horizontal, 12)
            .background(Capsule().fill(filled ? tint : tint.opacity(configuration.isPressed ? 0.2 : 0.08)))
            .overlay(Capsule().stroke(filled ? Color.clear : tint.opacity(0.35), lineWidth: 1))
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// Small pill status tag, e.g. `● LINK`, `OCCLUDED`.
struct Tag: View {
    let text: String
    let color: Color
    var solid = false

    var body: some View {
        Text(text.uppercased())
            .font(Theme.mono(10, .semibold))
            .tracking(0.8)
            .foregroundStyle(solid ? Color.black : color)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(solid ? color : color.opacity(0.12)))
    }
}

/// Section title: blaze, spaced caps.
struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(Theme.sans(11, .bold))
            .tracking(2.2)
            .foregroundStyle(Theme.blaze)
    }
}

/// Glowing status dot.
struct LED: View {
    let color: Color

    var body: some View {
        Circle().fill(color).frame(width: 7, height: 7).shadow(color: color, radius: 4)
    }
}

/// Blaze corner brackets + centre reticle over the camera feed.
struct HUDFrame: View {
    var body: some View {
        Canvas { context, size in
            let l: CGFloat = 26, inset: CGFloat = 16
            let blaze = Theme.blaze
            var path = Path()
            for (x, y, dx, dy) in [(inset, inset, 1.0, 1.0), (size.width - inset, inset, -1.0, 1.0),
                                   (inset, size.height - inset, 1.0, -1.0), (size.width - inset, size.height - inset, -1.0, -1.0)] {
                path.move(to: CGPoint(x: x + dx * l, y: y))
                path.addLine(to: CGPoint(x: x, y: y))
                path.addLine(to: CGPoint(x: x, y: y + dy * l))
            }
            context.stroke(path, with: .color(blaze), lineWidth: 2)
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            var reticle = Path()
            for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
                reticle.move(to: CGPoint(x: c.x + dx * 7, y: c.y + dy * 7))
                reticle.addLine(to: CGPoint(x: c.x + dx * 17, y: c.y + dy * 17))
            }
            context.stroke(reticle, with: .color(blaze.opacity(0.75)), lineWidth: 2)
        }
        .allowsHitTesting(false)
    }
}
