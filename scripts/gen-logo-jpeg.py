"""
Generate `public/brand/polytos-logo.jpg` from the official WebP mark.

The web pages use `polytos-logo.webp`, which is the asset the business
supplied and the source of truth. The PDF report writer cannot: a PDF embeds a
JPEG by passing its compressed bytes straight through `DCTDecode`, with no
decoder and therefore no dependency, and it has no such path for WebP. So the
document letterhead uses a JPEG derivative of the same mark.

It is a derivative, not a redesign. Three things happen and nothing else:

  * the image is cropped to the bounds of its opaque pixels, because the WebP
    carries transparent margin that would become a white band on the page;
  * the alpha is flattened onto white, which is what a printed letterhead is
    anyway — JPEG has no alpha channel;
  * it is resized to 660px wide, which is about 300dpi at the 54pt the
    letterhead draws it, and saved as a **baseline** JPEG with no chroma
    subsampling. Baseline matters: `readJpegSize` refuses a progressive file,
    because a PDF reader is not guaranteed to decode one through `DCTDecode`.

Run after replacing the WebP:

    python3 -I scripts/gen-logo-jpeg.py
"""

from PIL import Image

SOURCE = 'public/brand/polytos-logo.webp'
TARGET = 'public/brand/polytos-logo.jpg'
WIDTH = 660

image = Image.open(SOURCE).convert('RGBA')

bounds = image.split()[-1].getbbox()
if bounds is not None:
    image = image.crop(bounds)

flattened = Image.new('RGB', image.size, (255, 255, 255))
flattened.paste(image, mask=image.split()[-1])

height = round(flattened.size[1] * WIDTH / flattened.size[0])
flattened = flattened.resize((WIDTH, height), Image.LANCZOS)

flattened.save(
    TARGET,
    'JPEG',
    quality=92,
    subsampling=0,
    progressive=False,
    optimize=True,
)

print(f'wrote {TARGET} at {WIDTH}x{height}')
