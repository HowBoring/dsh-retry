window.__ModuleLoader__.load({
  id: "dsh-retry",
  factory: (require) => {
    const react = require("react")
    const exports = {}
    exports.name = "retry"
    exports.inject = ["slots", "remote", "remote.commands"]
    exports.apply = function apply(ctx) {
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        id: "retry-continue",
        order: 30,
        inject: (sessionId) => ({ sessionId }),
      }, function ContinueButton(props) {
        const target = props.useProjection?.("retry")
        const turn = typeof props.turn === "number" ? props.turn : props.turn?.turn
        if (!target || target.turn !== turn) return null
        const inbox = props.useProjection?.("inbox")
        const waiting = !!inbox && ((inbox["next-turn"]?.length ?? 0) > 0 || (inbox["next-step"]?.length ?? 0) > 0)
        const [notice, setNotice] = react.useState("")
        return react.createElement("span", null,
          react.createElement("button", {
            type: "button",
            disabled: waiting,
            title: waiting
              ? "A message is already waiting. Continue was not queued."
              : "Continue the unfinished task. This does not undo work or change the plan.",
            onClick: () => {
              setNotice("")
              ctx.remote.commands.execute(props.sessionId, `/retry --turn=${turn}`, []).then((result) => {
                if (!result.ok) {
                  setNotice(noticeText(result.error))
                  return
                }
                const text = result.value?.result?.text
                if (text) setNotice(text)
              }).catch((error) => {
                setNotice(noticeText(error))
              })
            },
          }, "Continue"),
          notice ? react.createElement("span", { role: "status" }, notice) : null,
        )
      }))
    }
    function noticeText(error) {
      const message = error instanceof Error ? error.message : error?.message ?? String(error)
      return error?.name === "AbortError" || message === "This operation was aborted"
        ? "Continue was cancelled before it was queued."
        : message
    }
    return exports
  },
})
