// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Mozilla Foundation

const withBitmap = async (image) => {
  if (
    !image?.data ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    typeof self.ImageData !== "function" ||
    typeof self.createImageBitmap !== "function"
  ) {
    return image;
  }

  try {
    image.bitmap = await self.createImageBitmap(
      new self.ImageData(image.data, image.width, image.height),
    );
  } catch {
    // Some browsers have partial ImageBitmap support in workers. The raw
    // pixel buffer remains available, so callers can still render normally.
  }
  return image;
};

const post = (id, image) => {
  const pixelTransfers = image?.data?.buffer ? [image.data.buffer] : [];
  if (image?.bitmap) {
    try {
      self.postMessage({ id, payload: image }, [
        image.bitmap,
        ...pixelTransfers,
      ]);
      return;
    } catch {
      image.bitmap.close?.();
      delete image.bitmap;
    }
  }
  self.postMessage({ id, payload: image }, pixelTransfers);
};

self.RenderResultTransport = { post, withBitmap };
