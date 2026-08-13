const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** A small TTY-only spinner that degrades to a normal log line when output is redirected. */
export function createSpinner(message, options = {}) {
  const stream = options.stream || process.stderr;
  const fallback = options.fallback || console;
  const intervalMs = options.intervalMs || 80;
  let timer = null;
  let frame = 0;

  function render() {
    stream.write(`\r${FRAMES[frame % FRAMES.length]} ${message}`);
    frame += 1;
  }

  return {
    start() {
      if (!stream.isTTY) {
        fallback.log(message);
        return;
      }
      render();
      timer = setInterval(render, intervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (stream.isTTY) {
        stream.clearLine?.(0);
        stream.cursorTo?.(0);
      }
    }
  };
}
