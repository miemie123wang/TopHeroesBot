const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const CHANNEL_ID = "1343771733173473311";

const MESSAGE_IDS = [
  {
    label: "已被识别",
    id: "1523993422791446638"
  },
  {
    label: "未被识别",
    id: "1525328284424863824"
  }
];

if (!DISCORD_TOKEN) {
  console.error("缺少 DISCORD_TOKEN 环境变量");
  process.exit(1);
}

const discordHeaders = {
  Authorization: DISCORD_TOKEN,
  "Content-Type": "application/json"
};

function extractGiftCode(content) {
  const backtickMatch = content.match(/`([A-Za-z0-9]{6,20})`/);

  const labelMatch = content.match(
    /(?:gift\s*code|giftcode|redeem\s*code)[^\n]*\n+[\s\S]*?([A-Za-z0-9]{6,20})/i
  );

  const blockMatch = content.match(/^([A-Za-z0-9]{6,20})$/m);

  const code =
    backtickMatch?.[1] ||
    labelMatch?.[1] ||
    blockMatch?.[1];

  if (!code) return null;

  const hasCodeKeyword = /code|gift|redeem/i.test(content);

  return hasCodeKeyword ? code : null;
}

function collectComponentText(components = []) {
  const texts = [];

  for (const component of components) {
    if (typeof component?.content === "string") {
      texts.push(component.content);
    }

    if (typeof component?.label === "string") {
      texts.push(component.label);
    }

    if (typeof component?.placeholder === "string") {
      texts.push(component.placeholder);
    }

    if (Array.isArray(component?.components)) {
      texts.push(...collectComponentText(component.components));
    }
  }

  return texts;
}

function normalizeDiscordMessage(message) {
  const parts = [];

  if (message.content) {
    parts.push(message.content);
  }

  for (const embed of message.embeds || []) {
    if (embed.title) {
      parts.push(embed.title);
    }

    if (embed.description) {
      parts.push(embed.description);
    }

    if (embed.author?.name) {
      parts.push(embed.author.name);
    }

    if (embed.footer?.text) {
      parts.push(embed.footer.text);
    }

    for (const field of embed.fields || []) {
      if (field.name) {
        parts.push(field.name);
      }

      if (field.value) {
        parts.push(field.value);
      }
    }
  }

  parts.push(...collectComponentText(message.components || []));

  for (const attachment of message.attachments || []) {
    if (attachment.filename) {
      parts.push(attachment.filename);
    }

    if (attachment.description) {
      parts.push(attachment.description);
    }
  }

  return parts
    .filter(Boolean)
    .join("\n")
    .trim();
}

function printSection(title, value) {
  console.log(`\n----- ${title} -----`);

  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  ) {
    console.log("(空)");
    return;
  }

  if (typeof value === "string") {
    console.log(JSON.stringify(value));
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

async function fetchDiscordMessage(messageId) {
  const params = new URLSearchParams({
    limit: "5",
    around: messageId
  });

  const url =
    `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?${params}`;

  const response = await fetch(url, {
    method: "GET",
    headers: discordHeaders
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  let messages;

  try {
    messages = JSON.parse(text);
  } catch {
    throw new Error(`Discord 返回不是 JSON: ${text}`);
  }

  if (!Array.isArray(messages)) {
    throw new Error(`Discord 返回格式异常: ${text}`);
  }

  const target = messages.find(
    message => String(message.id) === String(messageId)
  );

  if (!target) {
    throw new Error(
      `返回了 ${messages.length} 条消息，但没有找到目标消息 ${messageId}`
    );
  }

  return target;
}
async function inspectMessage(item) {
  console.log("\n");
  console.log("=".repeat(70));
  console.log(`${item.label}: ${item.id}`);
  console.log("=".repeat(70));

  const message = await fetchDiscordMessage(item.id);

  const normalizedText = normalizeDiscordMessage(message);

  printSection("MESSAGE TYPE", message.type);
  printSection("FLAGS", message.flags);

  printSection("AUTHOR", {
    id: message.author?.id,
    username: message.author?.username,
    bot: message.author?.bot,
    global_name: message.author?.global_name
  });

  printSection("CONTENT", message.content);
  printSection("EMBEDS", message.embeds);
  printSection("COMPONENTS", message.components);
  printSection("ATTACHMENTS", message.attachments);

  printSection("NORMALIZED TEXT", normalizedText);

  printSection(
    "旧逻辑 extractGiftCode(msg.content)",
    extractGiftCode(message.content || "")
  );

  printSection(
    "新逻辑 extractGiftCode(normalizedText)",
    extractGiftCode(normalizedText)
  );
}

async function main() {
  for (const item of MESSAGE_IDS) {
    try {
      await inspectMessage(item);
    } catch (error) {
      console.error(
        `检查消息 ${item.id} 失败：${error.message}`
      );
    }
  }
}

main().catch(error => {
  console.error("调试工具异常终止：", error);
  process.exit(1);
});
