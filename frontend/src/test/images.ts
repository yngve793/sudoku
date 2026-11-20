/** Tiny synthetic image files the mock decoder accepts (header bytes only). */

/** SOI + SOF0 header of a JPEG with the given size. */
export function fakeJpegBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const bytes = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255]
  bytes.push(width >> 8, width & 255, 0x03, ...new Array<number>(12).fill(0))
  return new Uint8Array(bytes)
}

export function fakeJpeg(width: number, height: number): Blob {
  return new Blob([fakeJpegBytes(width, height)], { type: 'image/jpeg' })
}

export function fakePng(width: number, height: number): Blob {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return new Blob([bytes], { type: 'image/png' })
}

export function fakePhotoFile(name = 'sudoku.jpg', width = 1200, height = 900): File {
  return new File([fakeJpegBytes(width, height)], name, { type: 'image/jpeg' })
}
