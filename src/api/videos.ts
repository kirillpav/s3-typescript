import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig } from "../config";
import { s3, S3Client, type BunRequest, type S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Video } from "../db/videos";

async function processVideoForFastStart(filePath: string) {
  const newPath = filePath + ".processed";

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-i",
      filePath,
      "-movflags",
      "faststart",
      "-map_metadata",
      "0",
      "-codec",
      "copy",
      "-f",
      "mp4",
      newPath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  await proc.exited;

  if (proc.exitCode != 0) {
    throw new Error("Error");
  }

  return newPath;
}

async function getVideoAspectRatio(filePath: string) {
  // ffprobe command
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  const output = await new Response(proc.stdout).text();
  const error = await new Response(proc.stderr).text();

  await proc.exited;

  if (proc.exitCode !== 0) {
    return error;
  }

  const data = JSON.parse(output);
  const videoStream = data.streams[0];

  if (!videoStream) {
    throw new NotFoundError("No video stream found");
  }

  const width = videoStream.width;
  const height = videoStream.height;

  const ratio = width / height;
  const landscapeRatio = 16 / 9;
  const portraitRatio = 9 / 16;
  const tolerance = 0.1;

  if (Math.abs(ratio - landscapeRatio) < tolerance) {
    return "landscape";
  } else if (Math.abs(ratio - portraitRatio) < tolerance) {
    return "portrait";
  } else {
    return "other";
  }
}

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_VIDEO_SIZE = 1 << 30;

  // getting video ID
  const { videoId } = req.params as { videoId: string };
  if (!videoId) {
    throw new BadRequestError("Invalid URL");
  }

  // authenticating user
  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Video doesnt exist");
  }
  if (video?.userID != userID) {
    throw new UserForbiddenError("User is not authorized to edit video");
  }

  // parsing video from formData
  const formData = await req.formData();
  const file = formData.get("video");

  if (!(file instanceof File)) {
    throw new BadRequestError("Video is not a file");
  }

  if (file.size > MAX_UPLOAD_VIDEO_SIZE) {
    throw new BadRequestError("File is too big");
  }

  if (file.type != "video/mp4") {
    throw new BadRequestError("File is not mp4");
  }

  const fileExtension = file.type.split("/")[1];
  const uploadPath = path.join(cfg.assetsRoot, `${videoId}.${fileExtension}`);
  await Bun.write(uploadPath, file);

  const aspectRatio = await getVideoAspectRatio(uploadPath);
  const processedVideo = await processVideoForFastStart(uploadPath);

  // putting video object in s3
  const newFileName = randomBytes(32).toString("hex");
  const fileKey = `${aspectRatio}/${newFileName}.${fileExtension}`;
  const videoFile = Bun.file(processedVideo);
  const s3Client = cfg.s3Client.file(fileKey, {
    type: file.type,
  });

  await s3Client.write(videoFile);

  // clean up
  await Bun.file(uploadPath).delete();
  await Bun.file(processedVideo).delete();

  const videoURL = `https://${cfg.s3CfDistribution}/${fileKey}`;

  video.videoURL = videoURL;

  updateVideo(cfg.db, video);

  return respondWithJSON(200, video);
}
