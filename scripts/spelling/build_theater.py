"""Original Echo Ocean shell theatre. Run with the existing Blender 4.2 in background mode.
No third-party meshes; the runtime supplies the existing Echo cast and the single live screen.
"""
import bpy
import math
import random
import hashlib
from pathlib import Path
from mathutils import Vector

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'frontend/public/games/echo-spelling'
OUT.mkdir(parents=True,exist_ok=True)
random.seed(118)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)

def mat(name,color,metal=0,rough=.45,emission=0):
    m=bpy.data.materials.new(name);m.diffuse_color=(*color,1);m.use_nodes=True
    bs=m.node_tree.nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*color,1)
    bs.inputs['Metallic'].default_value=metal;bs.inputs['Roughness'].default_value=rough
    bs.inputs['Coat Weight'].default_value=.35;bs.inputs['Coat Roughness'].default_value=.22
    if emission:bs.inputs['Emission Color'].default_value=(*color,1);bs.inputs['Emission Strength'].default_value=emission
    return m
navy=mat('Midnight glazed porcelain',(.012,.035,.085),.3,.39)
pearl=mat('Warm pearl shell',(.19,.34,.42),.28,.35)
gold=mat('Champagne brushed metal',(.8,.42,.09),.78,.28)
velvet=mat('Violet velvet',(.13,.045,.28),.08,.78)
reef=mat('Lagoon mineral',(.045,.35,.39),.18,.5)
violet=mat('Amethyst coral',(.26,.08,.4),.2,.49)
light=mat('Turquoise light',(.13,.77,1),.1,.4,2.7)
warm=mat('Honey light', (1,.56,.18),.15,.35,2)
dark=mat('Graphite microphone grille',(.022,.028,.045),.65,.42)
floor_mat=mat('Deep lagoon limestone',(.025,.095,.13),.18,.6)
shell_mat=mat('Iridescent indigo shell',(.035,.055,.19),.42,.31)

def material(o,m):o.data.materials.append(m);return o
def smooth(o):
    if o.type=='MESH':
        for p in o.data.polygons:p.use_smooth=True
    return o
def bevel(o,width=.1):
    mod=o.modifiers.new('Sculpted edge','BEVEL');mod.width=width;mod.segments=3
    bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=mod.name)
    return smooth(o)
def box(name,loc,scale,m,edge=.08):
    bpy.ops.mesh.primitive_cube_add(size=1,location=loc);o=bpy.context.object;o.name=name;o.scale=scale
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    material(o,m);return bevel(o,edge)
def cylinder(name,loc,radius,depth,m,vertices=64):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices,radius=radius,depth=depth,location=loc)
    o=bpy.context.object;o.name=name;material(o,m);return bevel(o,min(.07,depth/5))
def tube(name,points,radius,m,res=3):
    curve=bpy.data.curves.new(name,'CURVE');curve.dimensions='3D';curve.resolution_u=8
    curve.bevel_depth=radius;curve.bevel_resolution=res
    sp=curve.splines.new('BEZIER');sp.bezier_points.add(len(points)-1)
    for p,co in zip(sp.bezier_points,points):p.co=co;p.handle_left_type='AUTO';p.handle_right_type='AUTO'
    o=bpy.data.objects.new(name,curve);bpy.context.collection.objects.link(o);material(o,m);return o
def orb(name,loc,scale,m):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=12,location=loc);o=bpy.context.object;o.name=name;o.scale=scale;material(o,m);return smooth(o)
def ring(name,loc,radius,width,m,start=0,end=math.tau):
    return tube(name,[(loc[0]+radius*math.cos(a),loc[1]+radius*math.sin(a),loc[2]) for a in [start+(end-start)*i/64 for i in range(65)]],width,m,2)

# A deeply modelled foundation, layered stage edges and radial inlays.
cylinder('Theatre foundation',(0,0,-.55),14,.8,navy,128)
cylinder('Gold waterline',(0,0,-.16),13.97,.055,gold,128)
cylinder('Porcelain promenade',(0,0,-.09),13.9,.13,floor_mat,128)
stage=cylinder('Central performance dais',(0,3,-.22),9.2,.42,navy,128);stage.scale.y=.76
lip=ring('Sculpted gold stage lip',(0,3,-.008),9.05,.048,gold);lip.scale.y=.76
glow=ring('Lagoon footlight',(0,3,.018),8.95,.025,light);glow.scale.y=.76
for i in range(13):
    a=math.pi*.04+i*math.pi*.92/12
    tube('Pearl radial inlay',[(math.cos(a)*r,3+math.sin(a)*r*.76,.009) for r in [1.6,4.1,6.6,8.8]],.014,gold,1)
for r in [2.2,4.6,7.0]:
    o=ring('Engraved shell arc',(0,3,.01),r,.012,gold,0,math.pi);o.scale.y=.76

# A continuous, thick nacre shell: radial fluting has real volume, rather than a cage of poles.
vertices=[];faces=[];na=144;nr=24
def shell_point(a,r,back=0):
    ripple=math.cos(a*18)*.11*r
    scallop=1+.02*math.cos(a*18)*r*r
    return (math.cos(a)*r*11.9*scallop,10.5-1.5*math.sin(r*math.pi*.85)+ripple+back,.25+math.sin(a)*r*11.4*scallop)
for back in [0,.26]:
    for j in range(nr+1):
        for i in range(na+1):vertices.append(shell_point(math.pi*i/na,.018+.982*j/nr,back))
layer=(na+1)*(nr+1)
for side in range(2):
    for j in range(nr):
        for i in range(na):
            q=side*layer+j*(na+1)+i;f=(q,q+1,q+na+2,q+na+1);faces.append(f if side==0 else f[::-1])
for i in range(na):
    q=nr*(na+1)+i;faces.append((q,q+layer,q+layer+1,q+1))
mesh=bpy.data.meshes.new('Nacre shell sculpt');mesh.from_pydata(vertices,[],faces);mesh.update()
shell=bpy.data.objects.new('Monolithic scalloped shell',mesh);bpy.context.collection.objects.link(shell);material(shell,shell_mat);smooth(shell)
for i in range(19):
    a=math.pi*i/18
    path=[shell_point(a,r) for r in [.05,.3,.55,.8,1]]
    tube('Shell radial ridge',[(x,y-.035,z) for x,y,z in path],.085,pearl,3)
    tube('Gilded shell seam',[(x,y-.125,z) for x,y,z in path],.023,gold,2)
for radius,thickness,m in [(7.4,.26,navy),(7.08,.08,gold),(6.88,.04,light)]:
    tube('Pearl oculus',[(math.cos(a)*radius,9.7,5.1+math.sin(a)*radius*.77) for a in [math.tau*j/96 for j in range(97)]],thickness,m,3)

# One large display, shaped as a dimensional instrument with a real rear casing.
box('Display sculpted rear',(0,7.1,4.15),(11.6,.52,5.2),navy,.46)
box('Display champagne frame',(0,6.79,4.15),(11.3,.17,4.94),gold,.35)
box('Display inner enamel',(0,6.67,4.15),(11.04,.13,4.7),dark,.28)
for x in [-4.7,4.7]:
    tube('Screen stanchion',[(x,7.2,0),(x*.95,7.4,1.4),(x*.92,7.2,3)],.16,gold,3)
for x in [-5.55,5.55]:
    tube('Screen edge light',[(x,6.57,2.1),(x,6.57,4.1),(x,6.57,6.2)],.022,light,2)

# Microphone: weighted stepped base, machined stem, yoke, rounded capsule and fine grille.
cylinder('Microphone weighted foot',(0,2.12,.055),.29,.11,navy)
cylinder('Microphone base inlay',(0,2.12,.116),.25,.025,gold)
cylinder('Microphone stem',(0,2.12,.74),.035,1.25,gold,24)
cylinder('Microphone adjustment collar',(0,2.12,1.19),.055,.13,navy,24)
capsule=box('Microphone capsule',(0,2.12,1.52),(.24,.17,.39),gold,.075)
box('Microphone grille inset',(0,2.025,1.54),(.195,.022,.29),dark,.055)
for j in range(10):
    box('Capsule grille slot',(0,2.008,1.425+j*.025),(.18,.012,.009),pearl,.003)
tube('Microphone cradle',[(-.16,2.12,1.62),(-.18,2.12,1.29),(0,2.12,1.24),(.18,2.12,1.29),(.16,2.12,1.62)],.022,gold,3)
orb('Microphone jewel',(0,2.001,1.37),(.04,.009,.022),light)
# The host's pearl insignia is modelled into the microphone base, with its own flowing wave.
for j in range(3):
    tube('Echo flowing wave emblem',[(-.15,1.96,.13+j*.016),(-.07,1.93,.15+j*.016),(.03,1.94,.12+j*.016),(.15,1.97,.14+j*.016)],.006,gold,2)

# Audience balconies: intentional continuous crescent forms, repeated seats batched by material.
for row in range(3):
    radius=9.4+row*1.4;height=row*.27
    # Solid crescent tiers support the seats and catch the warm footlights.
    vs=[];fs=[];segments=64
    for z in [-.04,height+.04]:
        for r in [radius-.58,radius+.66]:
            for i in range(segments+1):
                a=math.pi*1.035+math.pi*.93*i/segments;vs.append((r*math.cos(a),r*math.sin(a),z))
    n=segments+1
    for i in range(segments):
        fs.extend([(2*n+i,2*n+i+1,3*n+i+1,3*n+i),(i,i+1,2*n+i+1,2*n+i),(n+i,3*n+i,3*n+i+1,n+i+1)])
    me=bpy.data.meshes.new('Crescent tier');me.from_pydata(vs,[],fs);me.update();o=bpy.data.objects.new('Audience sculpted terrace',me);bpy.context.collection.objects.link(o);material(o,navy);bevel(o,.035)
    ring('Audience balcony gold',(0,0,height),radius,.055,gold,math.pi*1.06,math.pi*1.94)
    for i in range(14+row*2):
        a=math.pi*1.08+(math.pi*.84)*i/(13+row*2)
        x,y=radius*math.cos(a),radius*math.sin(a)
        o=box('Velvet audience seat',(x,y,height+.32),(.68,.61,.15),velvet,.12);o.rotation_euler.z=a-math.pi/2
        o=box('Pearl seat back',(x*1.025,y*1.025,height+.68),(.72,.16,.67),navy,.16);o.rotation_euler.z=a-math.pi/2
        for dx in [-.31,.31]:
            px=x+dx*math.sin(a);py=y-dx*math.cos(a)
            cylinder('Seat gold pedestal',(px,py,height+.15),.035,.32,gold,12)

# Cohesive coral sculpture clusters, branching from a heavy root with controlled silhouettes.
for side in [-1,1]:
    for n,(cx,cy,size) in enumerate([(8.6,5.8,1.2),(10,2.8,1.5),(11,7.8,1.8),(7.6,9.4,1.1)]):
        x=cx*side;material_=violet if n%2 else reef
        orb('Coral mineral plinth',(x,cy,.18),(1.05,.86,.3),navy)
        for branch in range(7):
            angle=branch*2.39;nudge=math.sin(angle)*.65*size
            end=(x+nudge,cy+math.cos(angle)*.5*size,1.2+size*(.7+random.random()))
            tube('Sculpted coral antler',[(x,cy,.12),(x+nudge*.18,cy,.8*size),(x+nudge*.65,cy+math.cos(angle)*.2,end[2]*.7),end],.075*size,material_,3)
            orb('Coral pearl bud',end,(.095*size,)*3,warm if branch%3==0 else light)
            if branch%2==0:
                tube('Coral fork',[(x+nudge*.18,cy,.8*size),(x+nudge*.65+side*.3,cy+.1,end[2]*.65),(end[0]+side*.35,end[1]-.1,end[2]-.2)],.048*size,material_,3)
    # Fluted gallery columns frame the stage rather than filling its view.
    for y in [-2,3,8]:
        x=side*12.2
        cylinder('Column pedestal',(x,y,.18),.68,.36,navy)
        cylinder('Column gold socle',(x,y,.39),.58,.07,gold)
        for j in range(9):
            a=j*math.tau/9;tube('Fluted gallery column',[(x+math.cos(a)*.34,y+math.sin(a)*.34,.45),(x+math.cos(a)*.26,y+math.sin(a)*.26,3.3),(x+math.cos(a)*.5,y+math.sin(a)*.5,5.4)],.07,pearl,2)
        orb('Gallery lantern',(x,y,5.5),(.38,.38,.3),warm)

# Convert and batch by material. Geometry stays detailed; draw calls stay controlled.
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.convert(target='MESH')
for m in [navy,pearl,gold,velvet,reef,violet,light,warm,dark,floor_mat,shell_mat]:
    bpy.ops.object.select_all(action='DESELECT')
    meshes=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.data.materials and o.data.materials[0]==m]
    if not meshes:continue
    for o in meshes:o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join();bpy.context.object.name='Theatre_'+m.name.replace(' ','_')
bpy.ops.object.select_all(action='SELECT')
temp=OUT/'theater.pending.glb'
bpy.ops.export_scene.gltf(filepath=str(temp),export_format='GLB',export_yup=True,export_cameras=False,export_lights=False,export_extras=True)
digest=hashlib.sha256(temp.read_bytes()).hexdigest()[:12]
target=OUT/f'theater-{digest}.glb';temp.replace(target)
(OUT/'theater-source.json').write_text(__import__('json').dumps({'file':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size,'author':'English Coach original Echo Spelling theatre','generator':'scripts/spelling/build_theater.py'},indent=2)+'\n')
print('THEATER',target, target.stat().st_size)

# A genuinely modelled reef fish: tapered body, forked caudal fin, layered fins, gill and eyes.
# Separate small asset so one set of GPU instances can form a school without duplicating draw calls.
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
fish_blue=mat('Reef blue enamel',(.025,.30,.55),.35,.31)
fish_teal=mat('Luminous turquoise fins',(.045,.68,.62),.25,.38)
fish_gold=mat('Reef gold accent',(.96,.54,.08),.4,.3)
fish_eye=mat('Obsidian eyes',(.003,.008,.015),.15,.13)
fish_pearl=mat('Pearl belly',(.35,.70,.75),.18,.4)
vs=[];fs=[];rings=20;sides=20
for j in range(rings+1):
    t=j/rings;x=-.66+t*1.27
    radius=max(.012,math.sin(math.pi*t)**.7)*(.25-.07*t)
    for i in range(sides):
        a=i*math.tau/sides;vs.append((x,math.cos(a)*radius*.65,math.sin(a)*radius))
for j in range(rings):
    for i in range(sides):q=j*sides+i;right=j*sides+(i+1)%sides;fs.append((q,right,right+sides,q+sides))
mesh=bpy.data.meshes.new('Hydrodynamic fish body');mesh.from_pydata(vs,[],fs);mesh.update();o=bpy.data.objects.new('Reef fish body',mesh);bpy.context.collection.objects.link(o);material(o,fish_blue);smooth(o)
def fin(name,coords,m):
    me=bpy.data.meshes.new(name);me.from_pydata(coords,[],[tuple(range(len(coords)))]);me.update();ob=bpy.data.objects.new(name,me);bpy.context.collection.objects.link(ob);material(ob,m)
    solid=ob.modifiers.new('Fin volume','SOLIDIFY');solid.thickness=.012;bpy.context.view_layer.objects.active=ob;bpy.ops.object.modifier_apply(modifier=solid.name);bevel(ob,.009);return ob
fin('Forked caudal fin',[(-.56,0,0),(-1.04,0,.33),(-.92,0,.025),(-1.04,0,-.33)],fish_gold)
fin('Swept dorsal fin',[(-.4,0,.14),(-.35,0,.48),(-.03,0,.27),(.25,0,.17)],fish_teal)
fin('Ventral fin',[(-.32,0,-.17),(-.44,0,-.37),(.08,0,-.20)],fish_teal)
for side in [-1,1]:
    orb('Raised pearl eye rim',(.36,side*.112,.052),(.065,.028,.065),fish_gold)
    orb('Glossy fish eye',(.37,side*.135,.056),(.041,.015,.043),fish_eye)
    orb('Fish eye catchlight',(.385,side*.15,.073),(.012,.005,.012),fish_pearl)
    fin('Curved pectoral fin',[(.10,side*.14,.00),(-.20,side*.42,-.12),(-.25,side*.18,-.10)],fish_teal)
    tube('Fish gill',[(.22,side*.145,.13),(.15,side*.16,.015),(.20,side*.12,-.11)],.008,fish_gold,1)
    tube('Fish lateral stripe',[(-.55,side*.07,.03),(-.2,side*.16,.05),(.18,side*.145,.07),(.43,side*.08,.06)],.014,fish_gold,1)
for i in range(6):
    z=-.25+i*.1;tube('Caudal fin ray',[(-.6,0,0),(-.79,0,z*.6),(-.96,0,z)],.006,fish_teal,1)
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.convert(target='MESH')
for m in [fish_blue,fish_teal,fish_gold,fish_eye,fish_pearl]:
    bpy.ops.object.select_all(action='DESELECT');meshes=[o for o in bpy.context.scene.objects if o.type=='MESH' and o.data.materials and o.data.materials[0]==m]
    if not meshes:continue
    for o in meshes:o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]
    if len(meshes)>1:bpy.ops.object.join()
    bpy.context.object.name='Fish_'+m.name.replace(' ','_')
temp=OUT/'reef-fish.pending.glb';bpy.ops.export_scene.gltf(filepath=str(temp),export_format='GLB',export_yup=True,export_cameras=False,export_lights=False)
digest=hashlib.sha256(temp.read_bytes()).hexdigest()[:12];target=OUT/f'reef-fish-{digest}.glb';temp.replace(target)
(OUT/'fish-source.json').write_text(__import__('json').dumps({'file':target.name,'sha256':hashlib.sha256(target.read_bytes()).hexdigest(),'bytes':target.stat().st_size,'author':'English Coach original reef fish','generator':'scripts/spelling/build_theater.py'},indent=2)+'\n')
print('FISH',target,target.stat().st_size)
