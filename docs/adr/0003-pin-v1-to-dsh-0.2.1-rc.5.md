# v1 targets DeepSeek Harness 0.2.1-rc.5 only

The installed host is 0.2.1-rc.5. Its projection registry returns a synchronous disposer and is read with `stateOf(session, key)`. Master at ce7073d5 returns a thenable handle that is not a native Promise, so a guessed dual-generation branch would be untested. v1 has one projection reader and no compatibility adapter. A master port is a later change, not a runtime branch.
