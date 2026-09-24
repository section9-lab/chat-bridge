import SwiftUI

extension View {
    /// Runs `action` with the new value. `onChange(of:)` took a new closure in macOS 14, and the app still runs on macOS 13.
    @ViewBuilder
    func onChanged<Value: Equatable>(of value: Value, perform action: @escaping (Value) -> Void) -> some View {
        if #available(macOS 14, *) {
            onChange(of: value) { _, new in action(new) }
        } else {
            onChange(of: value, perform: action)
        }
    }
}
