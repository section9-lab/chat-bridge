import Foundation
import IOKit.pwr_mgt

final class PowerManager {
    private var assertion: IOPMAssertionID = 0
    func update(enabled: Bool, channelConnected: Bool) {
        if enabled && channelConnected && assertion == 0 {
            IOPMAssertionCreateWithName(kIOPMAssertionTypePreventUserIdleSystemSleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn), "Chat Bridge channel is active" as CFString, &assertion)
        } else if (!enabled || !channelConnected) && assertion != 0 {
            IOPMAssertionRelease(assertion)
            assertion = 0
        }
    }
    deinit { if assertion != 0 { IOPMAssertionRelease(assertion) } }
}
