"""Owner-authorized atlas packing/optimization. Original generated masters stay intact."""
from pathlib import Path
from PIL import Image
import json, zipfile, io, base64, re, xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'imports/source-assets-rush/owner-authored/echo-quiz-rush'
OUT = ROOT / 'frontend/public/games/echo-quiz-rush'

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    road = Image.open(SOURCE / 'causeway-master.png').convert('RGB').resize((1024,1024),Image.Resampling.LANCZOS)
    # A periodic boundary: approach the same scanline from both ends over 64px.
    original=road.copy()
    for y in range(64):
        t=y/64
        for x in range(1024):
            a=original.getpixel((x,y));b=original.getpixel((x,1023-y))
            middle=tuple(round((v+w)/2) for v,w in zip(a,b))
            road.putpixel((x,y),tuple(round(m*(1-t)+v*t) for m,v in zip(middle,a)))
            road.putpixel((x,1023-y),tuple(round(m*(1-t)+v*t) for m,v in zip(middle,b)))
    road.save(OUT/'causeway.webp',quality=86,method=6)
    raw=Image.open(SOURCE/'runner-master.png').convert('RGBA')
    atlas=Image.new('RGBA',(768,640));frames=[]
    # Actual transparent row gutters in the selected 1374x1145 master.
    # Generated subjects are not aligned to mathematical fifths of the image.
    row_edges=[0,224,447,670,883,1145]
    ground=[220,443,666,877,1122]
    assert raw.size==(1374,1145), 'Requalify authored gutters for a different master'
    for row in range(5):
        for col in range(6):
            box=(round(col*raw.width/6),row_edges[row],round((col+1)*raw.width/6),row_edges[row+1])
            drawing=raw.crop(box)
            # One common scale preserves body volume even for crouched recovery poses.
            drawing=drawing.resize((round(drawing.width*.5),round(drawing.height*.5)),Image.Resampling.LANCZOS)
            cell=Image.new('RGBA',(128,128))
            cell.alpha_composite(drawing,((128-drawing.width)//2,round(116-(ground[row]-row_edges[row])*.5)))
            # Generation leaves nonvisible RGB in alpha1-3 pixels. Clear only those
            # nearly transparent pixels in runtime exports; masters remain untouched.
            cell.putdata([(r,g,b,a) if a>3 else (0,0,0,0) for r,g,b,a in cell.getdata()])
            atlas.alpha_composite(cell,(col*128,row*128))
            frames.append({'x':col*128,'y':row*128,'w':128,'h':128})
    atlas.save(OUT/'runner.webp',lossless=True,method=6)
    gate_source=Image.open(SOURCE/'gates-master.png').convert('RGBA').resize((1152,768),Image.Resampling.LANCZOS)
    gates=Image.new('RGBA',(1536,384))
    for index,(col,row) in enumerate([(0,0),(1,0),(2,0),(0,1)]):
        drawing=gate_source.crop((col*384,row*384,(col+1)*384,(row+1)*384))
        drawing.putdata([(r,g,b,a) if a>3 else (0,0,0,0) for r,g,b,a in drawing.getdata()])
        gates.alpha_composite(drawing,(index*384,0))
    gates.save(OUT/'gates.webp',lossless=True,method=6)
    # Layered, editable raster master accepted by Krita and other OpenRaster editors.
    canvas=Image.new('RGBA',(1536,1536));thumb=road.copy();thumb.thumbnail((256,256))
    stack=ET.Element('image',w='1536',h='1536',name='Echo Quiz Rush painted masters');layers=ET.SubElement(stack,'stack')
    with zipfile.ZipFile(SOURCE/'echo-quiz-rush.ora','w') as z:
        z.writestr('mimetype','image/openraster',compress_type=zipfile.ZIP_STORED)
        for name,path in [('Gates and finish','gates-master.png'),('Explorer poses','runner-master.png'),('Causeway','causeway-master.png')]:
            src='data/'+path;z.write(SOURCE/path,src)
            ET.SubElement(layers,'layer',{'name':name,'src':src,'opacity':'1.0','visibility':'hidden' if name!='Causeway' else 'visible','composite-op':'svg:src-over','x':'0','y':'0'})
        z.writestr('stack.xml',ET.tostring(stack));buf=io.BytesIO();thumb.save(buf,format='PNG');z.writestr('Thumbnails/thumbnail.png',buf.getvalue())
    manifest={'runnerCell':128,'runnerColumns':6,'runnerRows':5,'gateCell':384,'gateColumns':4,'gateRows':1,'frames':frames,
              'files':[{ 'name':p.name,'bytes':p.stat().st_size,'dimensions':list(Image.open(p).size)} for p in [OUT/'causeway.webp',OUT/'runner.webp',OUT/'gates.webp']]}
    (OUT/'atlas.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    preview=ROOT/'docs/echo-quiz-rush/evidence/animation-preview.html'
    if preview.exists():
        data='data:image/webp;base64,'+base64.b64encode((OUT/'runner.webp').read_bytes()).decode()
        preview.write_text(re.sub(r"img.src='data:image/webp;base64,[^']+'", "img.src='"+data+"'", preview.read_text(encoding='utf-8')),encoding='utf-8')
    print(json.dumps(manifest['files']))

if __name__=='__main__':main()
