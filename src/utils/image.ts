const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
  "avif",
  "tiff",
  "tif",
  "heic",
  "heif",
]);

export function isImageFile(pathOrName: string): boolean {
  const lastSegment = pathOrName.split(/[\\/]/).pop() ?? pathOrName;
  const ext = lastSegment.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export function imageMimeType(pathOrName: string): string {
  const lastSegment = pathOrName.split(/[\\/]/).pop() ?? pathOrName;
  const ext = lastSegment.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "avif":
      return "image/avif";
    case "tiff":
    case "tif":
      return "image/tiff";
    case "heic":
    case "heif":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}