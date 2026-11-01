# Task Continuation

Carrying unfinished work forward after a Failed Turn or a User abort, without replaying history or pretending the human sent a new request.

## Language

**Continuation**:
A new Turn that carries unfinished work forward from a Continuation target. Asking for one is not itself a Continuation: the ask can be refused, or accepted before the new Turn exists. A Continuation is never implied from history alone.
_Avoid_: Retry, manual retry, replay, promptless continue, queued retry

**Continuation request**:
An explicit ask to start a Continuation of one specific Continuation target. An unnamed ask means the current Continuation target. A named ask for any other Turn is refused, not redirected. Accepting a request enqueues the Resume message; it does not mean the Continuation Turn has started, and it does not mean the work has finished. Any message already waiting outranks the request, human or not, including a Resume message already queued: the request is refused, not reordered.
_Avoid_: Retry success, queued state

**Continuation target**:
The latest closed Turn that ended as a Failed Turn or a User abort, that has Committed task input, and whose tool outcomes are all settled. A later Turn invalidates it. Only a session the user is driving has one — a session spawned under it does not.
_Avoid_: Eligible turn, retry target, historical turn

**Committed task input**:
A Human message or a Resume message committed into a Turn, so the task is in the conversation the model can see. A goal prompt, a schedule prompt, or a compaction checkpoint does not count, even when it uses the user role.
_Avoid_: Admitted work, inbox message, user-role message

**Human message**:
A message the person sent. It is not a plugin-queued user-role message.
_Avoid_: User message, Resume message, user-role message

**Resume message**:
The single short message that starts a Continuation. It is in the user role so the model can read it, but it is from the plugin, not from the human, and it does not restate the original request. It is not a grant of permission. It carries the same unfinished task forward: it does not undo work and it does not change the plan. In the transcript it is the host's execution notice, not a bubble from the person. A later failure of that Continuation can itself be continued, because this message is Committed task input.
_Avoid_: User message, retry prompt, original prompt

**Failed Turn**:
A closed Turn that ended in error. It can be a Continuation target. A Turn that completed, ran out of tokens, was blocked, or was forked is not a Failed Turn.
_Avoid_: User abort, interrupted, max-tokens, blocked

**User abort**:
The user stopped a running Turn on purpose. It is a pause, not a system failure and not a crash, and the Turn can be a Continuation target. A parent, hook, or disposed cancel is not a User abort, nor is an imported abort whose cause was never recorded.
_Avoid_: Interrupted, cancel, disposed, legacy abort, failure

**Unsafe tool outcome**:
A tool call whose effect outside the conversation was not settled. One such call in a Turn disqualifies that whole Turn as a Continuation target. A tool that returned a result, including an error result, is settled, not unsafe.
_Avoid_: Tool error, failed tool, force continue

**Automatic Request Retry**:
A repeated model request inside a Turn that is still open. It is not a Continuation and does not create one.
_Avoid_: Continuation, `/retry`
