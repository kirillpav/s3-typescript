import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { Buffer } from "node:buffer";
import path from "node:path";
import { randomBytes } from "node:crypto";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  // using random bytes for storage
  let newFileName = randomBytes(32).toString("base64url");
  console.log(newFileName);

  const formData = await req.formData();
  const file = formData.get("thumbnail");

  if (!(file instanceof File)) {
    throw new BadRequestError("Thumbnail is not a file");
  }

  const MAX_UPLOAD_FILE_SIZE = 10 << 20;

  if (file.size > MAX_UPLOAD_FILE_SIZE) {
    throw new BadRequestError("File exceeds maximum upload file size");
  }

  const mediaType = file.type;
  const fileExtension = mediaType.split("/")[1];
  const fileData: ArrayBuffer = await file.arrayBuffer(); // reading array buffer
  // converting data to file buffer
  const fileBuff = Buffer.from(fileData);

  // uploading to path
  const uploadPath = path.join(
    cfg.assetsRoot,
    `${newFileName}.${fileExtension}`
  );
  await Bun.write(uploadPath, fileBuff);

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  // get the video from db if user is authenticated

  const video = getVideo(cfg.db, videoId);

  if (!video) {
    throw new NotFoundError("Video doesnt exist");
  }

  if (video?.userID != userID) {
    throw new UserForbiddenError("User is not authorized to edit video");
  }

  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${newFileName}.${fileExtension}`;

  updateVideo(cfg.db, video);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  return respondWithJSON(200, video);
}

export function clearThumbnails() {
  videoThumbnails.clear();
}
