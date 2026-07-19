# Third-party notices

`pi-error-auto` was designed from two public Pi extensions:

- [`pi-hodor`](https://github.com/vurihuang/pi-hodor), used as the reference for retry detection, configuration, retry limits, and notifications. Copyright (c) 2026 Vuri; distributed under the MIT License.
- [`pi-invisible-continue`](https://github.com/monotykamary/pi-invisible-continue), used as the reference for triggering a canonical `AgentSession` turn with a hidden custom message and removing that marker in the `context` hook. Its package metadata declares the MIT License.

The resulting implementation also follows the public Pi extension API documentation for `pi.sendMessage()` and the `context` event.
