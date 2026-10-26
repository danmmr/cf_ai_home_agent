// Phone push through ntfy (https://ntfy.sh). The topic name is the only
// credential, so it lives in the NTFY_TOPIC secret. Unset means chat only.

export async function notify(
  env: Env,
  title: string,
  message: string,
  priority: "default" | "high" | "urgent" = "default",
  tags: string[] = [],
  // adds an "Open chat" button to the notification
  chatUrl?: string
): Promise<boolean> {
  if (!env.NTFY_TOPIC) return false;
  const server = env.NTFY_SERVER || "https://ntfy.sh";
  const headers: Record<string, string> = {
    // ntfy headers must be ASCII
    Title: title.replace(/[^\x20-\x7e]/g, ""),
    Priority: priority,
    Tags: tags.join(",")
  };
  if (chatUrl) headers.Actions = `view, Open chat, ${chatUrl}`;
  const res = await fetch(`${server}/${env.NTFY_TOPIC}`, {
    method: "POST",
    headers,
    body: message
  });
  return res.ok;
}
