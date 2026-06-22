export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const { text } = await request.json();
    if (!text || text.trim().length < 2) {
      return Response.json({ error: "text required" }, { status: 400 });
    }

    const key = text.trim().toLowerCase();

    // Check KV cache
    if (env.EXPLANATIONS) {
      const cached = await env.EXPLANATIONS.get(key);
      if (cached) {
        return Response.json({ explanation: cached, cached: true });
      }
    }

    // Call Claude API
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return Response.json({ error: "ANTHROPIC_API_KEY not configured" }, { status: 500 });
    }

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        output_config: { effort: "low" },
        system:
          "You are a knowledgeable AI assistant. The user has selected a piece of text from an AI industry daily digest and wants to understand it better. Provide a clear, concise explanation (2-4 sentences). If it's a person, explain who they are and why they matter. If it's a concept or term, explain it simply. If it's a quote, provide context. Be informative but brief.",
        messages: [{ role: "user", content: `Explain this: "${text.trim()}"` }],
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      return Response.json({ error: `Claude API error: ${res.status}` }, { status: 500 });
    }

    const data = await res.json();
    const explanation = data.content[0].text;

    // Save to KV cache
    if (env.EXPLANATIONS) {
      await env.EXPLANATIONS.put(key, explanation);
    }

    return Response.json({ explanation, cached: false });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
