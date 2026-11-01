# User abort is a Continuation target

A User abort is a pause, not an abandonment. Continue after the user stops a Turn carries the same unfinished task forward; it does not undo work and it does not change the plan. Crash interrupts, parent, hook, and disposed cancels, and imported aborts with no recorded cause, are not User aborts. Treating Esc as "do not offer Continue" matches a stop button better than a pause, and was rejected because it removes the recovery path this plugin exists to provide.
