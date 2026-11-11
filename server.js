
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const ipaddr = require("ipaddr.js");
const dns = require("dns").promises;
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "10kb" }));

function isPublicIP(address) {
  try {
    const parsed = ipaddr.process(address);
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

async function validateMediaURL(value) {
  let parsed;

  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Please enter a valid media URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS media URLs are supported.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("URLs containing login credentials are not supported.");
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") ||
      host.endsWith(".local")) {
    throw new Error("This host is not allowed.");
  }

  const records = await dns.lookup(host, { all: true });

  if (!records.length || records.some(record => !isPublicIP(record.address))) {
    throw new Error("This address is not publicly accessible.");
  }

  return parsed;
}

function runFFmpeg(input, output, format) {
  return new Promise((resolve, reject) => {
    const args = format === "mp3"
      ? ["-y", "-i", input, "-vn", "-codec:a", "libmp3lame",
         "-b:a", "192k", output]
      : ["-y", "-i", input, "-c:v", "libx264",
         "-c:a", "aac", "-movflags", "+faststart", output];

    const ffmpeg = spawn("ffmpeg", args);
    let errorOutput = "";

    ffmpeg.stderr.on("data", chunk => {
      errorOutput += chunk.toString();
    });

    ffmpeg.on("error", reject);

    ffmpeg.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error("Media conversion failed: " + errorOutput.slice(-500)));
    });
  });
}

app.get("/", (req, res) => {
  res.send("VIDDrop backend is running.");
});

app.post("/api/convert", async (req, res) => {
  const { url, format } = req.body || {};

  if (!url || !["mp3", "mp4"].includes(format)) {
    return res.status(400).json({
      error: "Provide a direct media URL and choose MP3 or MP4."
    });
  }

  const id = randomUUID();
  const input = path.join(os.tmpdir(), `${id}-input`);
  const output = path.join(os.tmpdir(), `${id}.${format}`);

  try {
    const parsed = await validateMediaURL(url);

    // Direct media files only. No redirects, streaming-site extraction,
    // or bypassing access controls.
    const response = await axios.get(parsed.href, {
      responseType: "stream",
      timeout: 30000,
      maxRedirects: 0,
      maxContentLength: 250 * 1024 * 1024,
      headers: { "User-Agent": "VIDDrop/1.0" }
    });

    const contentType = response.headers["content-type"] || "";

    if (!contentType.startsWith("video/") &&
        !contentType.startsWith("audio/") &&
        contentType !== "application/octet-stream") {
      response.data.destroy();
      throw new Error("That URL does not appear to be a direct audio or video file.");
    }

    let total = 0;

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(input);

      response.data.on("data", chunk => {
        total += chunk.length;

        if (total > 250 * 1024 * 1024) {
          response.data.destroy(new Error("File exceeds the 250 MB limit."));
        }
      });

      response.data.pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
      response.data.on("error", reject);
    });

    await runFFmpeg(input, output, format);

    res.download(output, `viddrop.${format}`, () => {
      fs.promises.rm(input, { force: true }).catch(() => {});
      fs.promises.rm(output, { force: true }).catch(() => {});
    });
  } catch (error) {
    fs.promises.rm(input, { force: true }).catch(() => {});
    fs.promises.rm(output, { force: true }).catch(() => {});

    if (!res.headersSent) {
      res.status(400).json({
        error: error.message || "Conversion failed."
      });
    }
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`VIDDrop backend running on port ${PORT}`);
});
