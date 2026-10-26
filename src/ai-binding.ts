// Llama 3.3 on Workers AI streams each token twice in one SSE event: as
// `response` and as `choices[0].delta.content`. workers-ai-provider (3.x
// and 4.x) emits both, so every word arrives doubled ("Hello Hello").
// This wraps the AI binding and drops `response` when it duplicates the
// delta, leaving every other event untouched.

function dedupeEvent(line: string): string {
  if (!line.startsWith("data: ")) return line;
  const data = line.slice(6);
  if (data === "[DONE]") return line;
  try {
    const event = JSON.parse(data) as {
      response?: unknown;
      choices?: { delta?: { content?: unknown } }[];
    };
    const content = event.choices?.[0]?.delta?.content;
    if (event.response !== undefined && event.response === content) {
      delete event.response;
      return `data: ${JSON.stringify(event)}`;
    }
  } catch {
    // not JSON: pass through
  }
  return line;
}

function dedupeStream(
  stream: ReadableStream<Uint8Array>
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines)
          controller.enqueue(encoder.encode(`${dedupeEvent(line)}\n`));
      },
      flush(controller) {
        if (buffer) controller.enqueue(encoder.encode(dedupeEvent(buffer)));
      }
    })
  );
}

export function dedupedAI(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop, receiver) {
      if (prop !== "run") return Reflect.get(target, prop, receiver);
      return async (...args: Parameters<Ai["run"]>) => {
        const result = await (
          target.run as (...a: unknown[]) => Promise<unknown>
        )(...args);
        return result instanceof ReadableStream ? dedupeStream(result) : result;
      };
    }
  });
}
