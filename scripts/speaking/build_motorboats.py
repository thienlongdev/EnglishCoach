"""Original Echo recreational launches. Blender 4.2 background, +Z up and -Y bow."""
import hashlib
import math
import sys
from pathlib import Path
import bpy
from mathutils import Vector
sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_archipelago_assets import OUT, clear_scene, make_mat, add_box, add_tube, add_cyl, add_sphere, batch_children_by_material


def group(name, parent=None):
    node = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(node)
    node.parent = parent
    return node


def build(name, long_roof):
    clear_scene()
    hull = group("Hull")
    gel = make_mat("Porcelain gelcoat", "eeeae0", .36)
    stripe = make_mat("Marine enamel", "174854" if long_roof else "305982", .33, .15)
    rail = make_mat("Brushed aluminium", "b9c7c9", .31, .85)
    rubber = make_mat("Fender rubber", "273437", .78)
    teak = make_mat("Deck cork", "ad9270", .79)
    seat = make_mat("Seat canvas", "cfb78d" if long_roof else "d8d8ca", .68)
    lens = make_mat("Windscreen", "90c4c9", .16, .08)
    lens.node_tree.nodes.get("Principled BSDF").inputs["Alpha"].default_value = .25
    # Each transverse station is lofted from keel to chine, rub rail and inner sole.
    vertices, faces, slots = [], [], []
    count = 37
    for i in range(count):
        u = i / (count-1)
        beam = 1.17 * (1-.12*(1-u)**4) * max(.018, (1-u**3.7)**.64)
        y = 3.0 - 6.65*u
        sheer = .65 + .29*u**4
        section = [(0,-.50+.36*u**4),(.73,-.13),(.99,.31),(1,.48),(1,sheer),
                   (.91,sheer),(.83,.31),(-.83,.31),(-.91,sheer),(-1,sheer),(-1,.48),(-.99,.31),(-.73,-.13)]
        n = len(section)
        for x,z in section:
            vertices.append((x*beam, y, z))
        if i:
            for k in range(n):
                prev=(i-1)*n+k
                after=(i-1)*n+(k+1)%n
                faces.append((prev, after, after+n, prev+n))
                slots.append(1 if k in (2,10) else 2 if k==6 else 0)
    faces.extend([tuple(reversed(range(n))),tuple(range((count-1)*n,count*n))])
    slots.extend([0,0])
    mesh=bpy.data.meshes.new("Hard chine loft")
    mesh.from_pydata(vertices,[],faces)
    mesh.update()
    shell=bpy.data.objects.new("Marine shell",mesh)
    bpy.context.collection.objects.link(shell)
    shell.parent=hull
    for material in (gel,stripe,teak): mesh.materials.append(material)
    uv=mesh.uv_layers.new()
    for p,slot in zip(mesh.polygons,slots):
        p.material_index=slot
        p.use_smooth=slot!=2
        for idx in p.loop_indices:
            v=mesh.vertices[mesh.loops[idx].vertex_index].co
            uv.data[idx].uv=((v.y+3.65)/6.65,(v.x+1.2)/2.4)
    def box(label,loc,size,mat,parent=hull,bevel=.03,rot=(0,0,0)):
        return add_box(label,loc,size,mat,rot,bevel,parent)
    def tube(label,points,r,mat,parent=hull,closed=False):
        return add_tube(label,points,r,mat,parent=parent,cyclic=closed)
    console=group("Helm",hull)
    box("Console",(0,-.22,.85),(.78,.59,1.08),gel,console,.09)
    box("Chartplotter",(0,.085,1.29),(.32,.034,.18),rubber,console)
    box("Screen",(0,.107,1.31),(.27,.012,.12),stripe,console)
    box("Windscreen",(0,-.47,1.56),(.96,.035,.56),lens,console,.02,(-.18,0,0))
    for x in [-.47,.47]:
        tube("Screen frame",[(x,-.42,1.27),(x,-.53,1.85)],.017,rail,console)
    wheel=group("SteeringWheel",hull)
    wheel.location=(0,.20,1.19)
    circle=[(.205*math.cos(a*math.tau/32),0,.205*math.sin(a*math.tau/32)) for a in range(32)]
    tube("Leather rim",circle,.022,rubber,wheel,True)
    for a in [0,2.1,4.2]:
        tube("Spoke",[(0,0,0),(.19*math.cos(a),0,.19*math.sin(a))],.013,rail,wheel)
    tube("Throttle lever",[(.31,.08,1.12),(.33,.2,1.27)],.017,rail,console)
    add_sphere("Throttle grip",(.33,.2,1.27),(.04,.04,.05),rubber,parent=console)
    seating=group("Seats",hull)
    for y,w in [(.78,.58),(-1.64,.85),(2.12,1.47)]:
        box("Seat plinth",(0,y,.48),(w*.83,.41,.34),gel,seating)
        box("Boxed cushion",(0,y,.73),(w,.51,.15),seat,seating,.07)
        box("Bolster",(0,y+.23,.89),(w,.13,.29),seat,seating,.06)
    top=group("Canopy",hull)
    reach=1.42 if long_roof else .98
    for x in [-.75,.75]:
        tube("T-top frame",[(x,.94,.37),(x*.92,.73,2.18),(x*.92,.58,2.37),(x*.92,-.88,2.37),(x,-1.05,.36)],.036,rail,top)
    for a in (-1,1):
        tube("Bow rail",[(a*.96,-1.22,.67),(a*.94,-1.38,.97),(a*.70,-2.35,1.09),(a*.20,-3.24,1.12)],.022,rail)
        tube("Rail stanchion",[(a*.7,-2.35,.73),(a*.7,-2.35,1.09)],.018,rail)
        tube("Rail return",[(a*.20,-3.24,1.12),(a*.19,-3.25,.86)],.018,rail)
    for k in range(7):
        box("Chart grid",(-.11+.035*k,.116,1.306+.016*math.sin(k)),(.032,.004,.008),teak,console,.001)
    for x in [-.26,.26]:
        add_cyl("Dial",(x,.108,1.31),.055,.012,rail,24,rot=(math.pi/2,0,0),parent=console)
        box("Needle",(x,.12,1.32),(.009,.008,.045),rubber,console,.002,rot=(0,.5,0))
    for y in [1.34,1.51,1.68]:
        box("Engine hatch channel",(0,y,.321),(1.35,.012,.008),rubber,bevel=.002)
    box("Sun top",(0,-.09,2.40),(1.83,reach*2,.11),stripe,top,.05)
    for x in [-.9,.9]:
        for y in [-1.51,2.26]:
            box("Mooring cleat",(x,y,.73),(.065,.23,.055),rail)
        lamp=make_mat("Port" if x<0 else "Starboard","b93025" if x<0 else "30a875",.3)
        box("Running light",(x,-1.58,.75),(.095,.12,.065),lamp)
    motor=group("Outboard",hull)
    motor.location=(0,3.08,.48)
    box("Cast engine case",(0,.09,.17),(.56,.62,.73),stripe,motor,.12)
    box("Acoustic lid",(0,.07,.53),(.55,.61,.12),rubber,motor,.055)
    for x in [-.277,.277]:
        for k in range(4):
            box("Cooling louvre",(x,.12+.054*k,.35),(.016,.026,.095),rubber,motor,.008)
        box("Enamel pinstripe",(x,.045,.15),(.018,.37,.023),gel,motor,.007)
    for y in [-.1,.05]:
        box("Trim bracket",(0,y,-.22),(.31,.12,.17),rail,motor)
    add_cyl("Prop shaft",(0,.18,-.66),.073,.26,rubber,18,rot=(math.pi/2,0,0),parent=motor)
    box("Exhaust leg",(0,.13,-.36),(.13,.20,.65),rubber,motor)
    box("Cavitation plate",(0,.14,-.58),(.37,.37,.04),rail,motor)
    prop=group("Propeller",motor)
    prop.location=(0,.26,-.66)
    for a in range(3):
        angle=a*math.tau/3
        add_sphere("Pitched blade",(.098*math.sin(angle),0,.098*math.cos(angle)),(.06,.025,.13),rail,
                   rot=(.25,angle,.18),parent=prop)
    for node in (console,seating,top):
        batch_children_by_material(node)
    tmp=OUT/(name+"-export.glb")
    bpy.ops.export_scene.gltf(filepath=str(tmp),export_format="GLB",export_yup=True)
    digest=hashlib.sha256(tmp.read_bytes()).hexdigest()[:12]
    target=OUT/f"{name}-{digest}.glb"
    tmp.replace(target)
    print("MOTOR_ASSET",target.name,target.stat().st_size)


for vessel, extended in [("pelagic",True),("tern",False)]:
    build(vessel,extended)
