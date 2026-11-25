"""Export genuine QA captures at store dimensions; never alter depicted functionality."""
import os
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / 'assets'
OUT.mkdir(exist_ok=True)
SHOTS = Path(os.environ.get('ECHO_ANYWHERE_SHOTS_DIR', str(OUT / 'raw-shots')))
for source, target in [
    ('21-card-light.png', '01-dictionary-light.png'),
    ('21-card-dark.png', '02-dictionary-dark.png'),
    ('12-reader.png', '03-focus-reading.png'),
]:
    src_file = SHOTS / source
    if not src_file.is_file():
        continue
    image = Image.open(src_file).convert('RGB')
    assert image.width * 800 == image.height * 1280
    image.resize((1280, 800), Image.Resampling.LANCZOS).save(OUT / target)

Image.open(ROOT / 'extension/echo-anywhere/src/icons/icon-128.png').save(OUT / 'icon-128.png')

generated_env = os.environ.get('ECHO_ANYWHERE_PROMO_DIR')
if generated_env:
    generated_dir = Path(generated_env)
    for src_name, dst_name, size in [
        ('promo-small-src.png', 'promo-small.png', (440, 280)),
        ('promo-marquee-src.png', 'promo-marquee.png', (1400, 560)),
    ]:
        src_img = generated_dir / src_name
        if src_img.is_file():
            ImageOps.fit(Image.open(src_img).convert('RGB'), size, method=Image.Resampling.LANCZOS).save(OUT / dst_name)

for file in OUT.iterdir():
    if file.suffix == '.png':
        with Image.open(file) as image:
            print(f'{file.name}: {image.size}, {image.mode}')
