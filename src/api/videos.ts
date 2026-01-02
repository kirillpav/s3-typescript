import { respondWithJSON } from "./json";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { type ApiConfig } from "../config";
import { S3Client, type BunRequest, type S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import path from "node:path";
import { randomBytes } from "node:crypto";

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

  // putting video object in s3
  const newFileName = randomBytes(32).toString("hex");
  const fileKey = `${newFileName}.${fileExtension}`;
  const videoFile = Bun.file(uploadPath);
  const s3Client = cfg.s3Client.file(fileKey, {
    type: file.type,
  });

  await s3Client.write(videoFile);

  // clean up
  await Bun.file(uploadPath).delete();

  const s3URL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${fileKey}`;
  video.videoURL = s3URL;
  updateVideo(cfg.db, video);

  return respondWithJSON(200, null);
}
