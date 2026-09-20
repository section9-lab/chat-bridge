import ApplicationServices

enum MessagesSettingsOpener {
    enum Failure: Error { case accessibilityRequired, settingsUnavailable }

    static func openUsingMenu(processIdentifier: pid_t) throws {
        guard AXIsProcessTrusted() else { throw Failure.accessibilityRequired }
        let application = AXUIElementCreateApplication(processIdentifier)
        AXUIElementSetMessagingTimeout(application, 2)
        guard let menuBar = attribute(application, kAXMenuBarAttribute),
              CFGetTypeID(menuBar) == AXUIElementGetTypeID() else { throw Failure.settingsUnavailable }
        let entries = children(menuBar as! AXUIElement).flatMap(children).flatMap(children)
        guard let settings = entries.first(where: {
            attribute($0, kAXMenuItemCmdCharAttribute) as? String == "," &&
                attribute($0, kAXMenuItemCmdModifiersAttribute) as? Int == 0 &&
                attribute($0, kAXEnabledAttribute) as? Bool == true
        }), AXUIElementPerformAction(settings, kAXPressAction as CFString) == .success else {
            throw Failure.settingsUnavailable
        }
    }

    private static func children(_ element: AXUIElement) -> [AXUIElement] {
        attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }
}
