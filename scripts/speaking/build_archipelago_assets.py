"""Original Echo Living Archipelago 4.5 3D asset generator (Blender 4.2 headless).
Produces two decoder-free, content-hashed GLB packages in frontend/public/speaking/arena/:
  1. rowboat-<hash>.glb           (Rowboat_Hull, Oar_L, Oar_R with exact oarlock pivots)
  2. archipelago-props-<hash>.glb (11 coastal landmark, dock, botanical, and interactive props)

Convention: Blender Z-up, forward = -Y -> exports with export_yup=True to Three.js Y-up, forward = +Z.
Zero Draco/Meshopt/KTX2 WASM decoders so strict production CSP is 100% satisfied.
"""
import bpy
import bmesh
import math
import json
import random
import hashlib
import numpy as np
from pathlib import Path
from mathutils import Vector, Matrix, Euler

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "frontend" / "public" / "speaking" / "arena"
OUT.mkdir(parents=True, exist_ok=True)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


def make_mat(name, hex_color, rough=0.58, metal=0.0, emission_hex=None, emission_strength=0.0, coat=0.12):
    h = hex_color.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    lin = [((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in srgb]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.diffuse_color = (*lin, 1.0)
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.28
    if emission_hex and emission_strength > 0:
        eh = emission_hex.lstrip("#")
        es = [int(eh[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
        el = [((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in es]
        bsdf.inputs["Emission Color"].default_value = (*el, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return m


def assign_mat(obj, mat):
    if obj.data.materials:
        obj.data.materials[0] = mat
    else:
        obj.data.materials.append(mat)
    return obj


def shade_smooth(obj, auto_angle_deg=42.0):
    if obj.type == "MESH":
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj


def apply_bevel(obj, width=0.015, segments=2):
    mod = obj.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(32.0)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return shade_smooth(obj)


def add_box(name, loc, dims, mat, rot=(0, 0, 0), bevel_w=0.012, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign_mat(o, mat)
    if bevel_w > 0:
        apply_bevel(o, bevel_w, 2)
    if parent:
        o.parent = parent
    return o


def add_cyl(name, loc, radius, depth, mat, verts=20, rot=(0, 0, 0), bevel_w=0.008, parent=None, r_top=None):
    if r_top is not None:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=radius, radius2=r_top, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=radius, depth=depth, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    assign_mat(o, mat)
    if bevel_w > 0:
        apply_bevel(o, min(bevel_w, depth * 0.2, radius * 0.35), 2)
    else:
        shade_smooth(o)
    if parent:
        o.parent = parent
    return o


def add_sphere(name, loc, scale, mat, segs=18, rings=12, rot=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=1.0, location=loc, rotation=rot)
    o = bpy.context.object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    assign_mat(o, mat)
    shade_smooth(o)
    if parent:
        o.parent = parent
    return o


def add_tube(name, points, radius, mat, res_u=8, bevel_res=2, taper_end=1.0, parent=None, cyclic=False):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = res_u
    curve.bevel_depth = radius
    curve.bevel_resolution = bevel_res
    # Closed ends: an oar handle or a branch seen end-on is solid, never a hollow pipe.
    curve.use_fill_caps = not cyclic
    sp = curve.splines.new("NURBS" if len(points) >= 4 else "POLY")
    sp.points.add(len(points) - 1)
    for i, pt in enumerate(points):
        t = i / max(1, len(points) - 1)
        r_fac = 1.0 * (1.0 - t) + taper_end * t
        sp.points[i].co = (pt[0], pt[1], pt[2], 1.0)
        sp.points[i].radius = r_fac
    if sp.type == "NURBS":
        sp.use_endpoint_u = not cyclic
        sp.order_u = min(4, len(points))
    sp.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    assign_mat(obj, mat)
    shade_smooth(obj)
    obj.select_set(False)
    if parent:
        obj.parent = parent
    return obj


def batch_children_by_material(root_empty):
    """Join all mesh children of root_empty sharing a material into one mesh per material (preserving root_empty local transforms)."""
    bpy.ops.object.select_all(action="DESELECT")
    children = [c for c in list(root_empty.children) if c.type == "MESH" and c.data.materials]
    by_mat = {}
    for c in children:
        by_mat.setdefault(c.data.materials[0].name, []).append(c)
    for mat_name, objs in by_mat.items():
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.parent = None
        # Keep world transforms clean, join, then re-parent with inverse
        for o in objs:
            o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1:
            bpy.ops.object.join()
        merged = bpy.context.view_layer.objects.active
        merged.name = f"{root_empty.name}_{mat_name}"
        # Express geometry in root_empty's local space so merged has identity local transform
        inv = root_empty.matrix_world.inverted()
        merged.data.transform(inv @ merged.matrix_world)
        merged.matrix_world = root_empty.matrix_world.copy()
        merged.parent = root_empty
        merged.matrix_parent_inverse = Matrix.Identity(4)
        merged.location = (0, 0, 0)
        merged.rotation_euler = (0, 0, 0)
        merged.scale = (1, 1, 1)
        shade_smooth(merged)


# ==============================================================================
# 4.5: FOLIAGE CARDS (one generated RGBA atlas, alpha-tested) + ECHO WHALE MONUMENT
# ==============================================================================
WHALE_GLB = ROOT / "frontend" / "public" / "models" / "whale-e0569b41.glb"


def foliage_atlas(size=1024):
    """Original painted atlas, drawn here: a pinnate palm frond (u 0..0.5), broad tropical leaves (u 0.5..1, v 0..0.5) and a
    bougainvillea bract cluster (u 0.5..1, v 0.5..1). Anti-aliased ellipses on a transparent ground; row 0 is the bottom."""
    rng = random.Random(4510)
    img = np.zeros((size, size, 4), np.float32)

    def blob(cx, cy, rx, ry, ang, rgb, soft=1.2):
        pad = int(max(rx, ry)) + 3
        x0, x1 = max(0, int(cx - pad)), min(size, int(cx + pad))
        y0, y1 = max(0, int(cy - pad)), min(size, int(cy + pad))
        if x1 <= x0 or y1 <= y0:
            return
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32) + .5
        c, s_ = math.cos(ang), math.sin(ang)
        dx, dy = xx - cx, yy - cy
        u, v = (dx * c + dy * s_) / rx, (-dx * s_ + dy * c) / ry
        d = np.sqrt(u * u + v * v)
        cov = np.clip((1.0 - d) * min(rx, ry) / soft + .5, 0, 1)
        # light vein down the long axis, darker edge
        shade = .82 + .18 * np.clip(1 - np.abs(v) * 2.2, 0, 1) - .1 * np.clip(d - .7, 0, 1)
        col = np.array(rgb, np.float32)[None, None, :] * shade[..., None]
        a = cov[..., None]
        reg = img[y0:y1, x0:x1]
        reg[..., :3] = reg[..., :3] * (1 - a) + col * a
        reg[..., 3] = np.maximum(reg[..., 3], cov)

    # Palm frond: tapering rachis with ~30 leaflet pairs, fresher green towards the tip.
    half = size // 2
    for k in range(34):
        t = k / 33
        y = 40 + t * (size - 90)
        length = 230 * math.sin(math.pi * (.12 + .86 * t)) * (1 - .25 * t) + 22
        width = 8.5 * (1 - .35 * t) + 2
        for side in (-1, 1):
            a = math.radians(62 - 30 * t + rng.uniform(-4, 4))
            cx = half / 2 + side * math.cos(a) * length / 2
            cy = y + math.sin(a) * length / 2
            g = .36 + .22 * t + rng.uniform(-.05, .05)
            blob(cx, cy, length / 2, width, side * a if side > 0 else math.pi - a, (.16 + .12 * t, g, .14 + .04 * t))
    for k in range(60):
        t = k / 59
        blob(half / 2, 30 + t * (size - 80), 7, 4.5 * (1 - .6 * t) + 1.2, math.pi / 2, (.62, .66, .38))
    # Broad tropical leaves fanning from the bottom centre of their cell.
    for k in range(5):
        a = math.radians(30 + k * 30 + rng.uniform(-6, 6))
        L = rng.uniform(150, 205)
        cx, cy = half + half / 2 + math.cos(a) * L * .55, 24 + math.sin(a) * L * .55
        blob(cx, cy, L * .55, L * .21, a, (.13 + .05 * (k % 2), .38 + .06 * (k % 3), .17))
    # Bougainvillea bracts: magenta and coral, tiny cream florets, a few leaves among them.
    for k in range(10):
        a = rng.uniform(0, math.tau); r = rng.uniform(20, 170)
        blob(half + half / 2 + math.cos(a) * r, half + half / 2 + math.sin(a) * r, 46, 20, a, (.16, .42, .2))
    for k in range(70):
        a = rng.uniform(0, math.tau); r = rng.uniform(0, 180) ** .9 * 1.05
        cx, cy = half + half / 2 + math.cos(a) * r, half + half / 2 + math.sin(a) * r
        hue = (.86, .2, .5) if k % 3 else (.95, .42, .38)
        for petal in range(3):
            pa = petal * math.tau / 3 + rng.uniform(0, 1)
            blob(cx + math.cos(pa) * 9, cy + math.sin(pa) * 9, 13, 9, pa, hue)
        blob(cx, cy, 3.5, 3.5, 0, (.98, .94, .78))
    im = bpy.data.images.new("Arch_FoliageAtlas", size, size, alpha=True)
    im.alpha_mode = "STRAIGHT"
    im.pixels.foreach_set(img.ravel())
    im.pack()
    return im


def foliage_material(atlas):
    m = bpy.data.materials.new("Arch_FoliageLeaf")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    t = nt.nodes.new("ShaderNodeTexImage"); t.image = atlas
    nt.links.new(t.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(t.outputs["Alpha"], b.inputs["Alpha"])
    b.inputs["Roughness"].default_value = .78
    if "Coat Weight" in b.inputs:
        b.inputs["Coat Weight"].default_value = 0.0
    m.blend_method = "CLIP"
    m.alpha_threshold = .5
    m.use_backface_culling = False
    return m


def card_mesh(name, quads, mat, parent):
    """quads: list of (4 corners, 4 uvs). One mesh, one material, flat cards with their own UVs."""
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new("UVMap")
    for corners, uvs in quads:
        vs = [bm.verts.new(c) for c in corners]
        f = bm.faces.new(vs)
        for loop, coord in zip(f.loops, uvs):
            loop[uv].uv = coord
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    assign_mat(ob, mat)
    ob.parent = parent
    return ob


def glaze_from(src, name):
    """The whale's own colour map as a ceramic glaze: its blue becomes ocean enamel, its pale belly pearl, the eye a brass inlay."""
    w, h = src.size
    px = np.array(src.pixels[:], np.float32).reshape(h, w, 4)
    r, g, b = px[..., 0], px[..., 1], px[..., 2]
    lum = .2126 * r + .7152 * g + .0722 * b
    blue = np.clip((b - r) * 2.6, 0, 1)
    # 8-bit images hold display (sRGB) values: these are the colours as seen.
    pearl = np.array([.95, .93, .88], np.float32)
    enamel = np.array([.47, .69, .75], np.float32)
    deep = np.array([.34, .58, .66], np.float32)
    tone = enamel[None, None] * (1 - lum[..., None] * .6) + deep[None, None] * (lum[..., None] * .6)
    mix = (blue * .82)[..., None]
    out = pearl[None, None] * (1 - mix) + tone * mix
    eye = (lum < .06)[..., None]
    out = np.where(eye, np.array([.74, .58, .3], np.float32)[None, None], out)
    im = bpy.data.images.new(name, w, h, alpha=False)
    im.pixels.foreach_set(np.concatenate([out, np.ones((h, w, 1), np.float32)], axis=2).ravel())
    im.pack()
    return im


def build_whale_monument(p_whale, m_stone, m_seaglass, m_pearl, m_brass):
    """Echo breaching from a wave crest on a travertine plinth. The whale is the project's own Echo model (Low poly animated
    Cartoon Whale by Blue Colossus Studio, CC BY 4.0), posed with its own skeleton, smoothed and glazed."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(WHALE_GLB))
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == "ARMATURE")
    body = next(o for o in new if o.type == "MESH" and len(o.data.vertices) > 200)
    src_img = next((n.image for m in body.data.materials if m and m.use_nodes for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image), None)
    if arm.animation_data:
        arm.animation_data.action = None
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
    # A gentle breaching arc along the spine; flippers held out from the body; flukes lifted.
    for name, deg in (("Bone.001_02", 5), ("Bone.002_03", 9), ("Bone.003_04", 12), ("Bone.004_05", 11), ("Bone.005_06", 8), ("Bone.006_07", 6)):
        if name in arm.pose.bones:
            arm.pose.bones[name].rotation_euler = (math.radians(deg), 0, 0)
    for side, sign in (("L", 1), ("R", -1)):
        for k, deg in ((1, 14), (2, 9), (3, 6)):
            pb = next((b for b in arm.pose.bones if b.name.startswith(f"fin{k}.{side}")), None)
            if pb:
                pb.rotation_euler = (0, 0, math.radians(deg * sign))
    bpy.ops.object.mode_set(mode="OBJECT")
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(body.evaluated_get(dg), preserve_all_data_layers=True, depsgraph=dg)
    me.transform(body.matrix_world)
    whale = bpy.data.objects.new("EchoWhaleSculpt", me)
    bpy.context.collection.objects.link(whale)
    for o in new:
        if o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)
    # Head up (the import stands Echo on its head), leaning towards the plaza (-Y, Three's +Z).
    whale.data.transform(Matrix.Rotation(math.pi, 4, "X"))
    whale.data.transform(Matrix.Rotation(math.radians(-30), 4, "X"))
    bb = [Vector(v.co) for v in whale.data.vertices]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    k = 3.05 / (hi.z - lo.z)
    whale.data.transform(Matrix.Scale(k, 4))
    lo, hi = lo * k, hi * k
    whale.data.transform(Matrix.Translation(Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2 + .15, .7 - lo.z))))
    sub = whale.modifiers.new("Smooth", "SUBSURF"); sub.levels = 2; sub.render_levels = 2
    bpy.context.view_layer.objects.active = whale
    bpy.ops.object.modifier_apply(modifier="Smooth")
    for poly in whale.data.polygons:
        poly.use_smooth = True
    glaze = make_mat("Arch_EchoGlaze", "#ffffff", rough=0.46, coat=0.05)
    if src_img is not None:
        img = glaze_from(src_img, "Arch_EchoGlazeMap")
        t = glaze.node_tree.nodes.new("ShaderNodeTexImage"); t.image = img
        glaze.node_tree.links.new(t.outputs["Color"], glaze.node_tree.nodes["Principled BSDF"].inputs["Base Color"])
    whale.data.materials.clear()
    whale.data.materials.append(glaze)
    whale.parent = p_whale

    # Plinth: two travertine steps, a bronze band, a sea-glass basin with a pearl water face.
    add_cyl("WhaleStep1", (0, 0, .11), 1.9, .22, m_stone, verts=48, r_top=1.84, parent=p_whale)
    add_cyl("WhaleStep2", (0, 0, .32), 1.62, .2, m_stone, verts=48, r_top=1.56, parent=p_whale)
    add_cyl("WhaleBand", (0, 0, .43), 1.585, .045, m_brass, verts=64, parent=p_whale)
    add_cyl("WhaleBasinWall", (0, 0, .55), 1.42, .22, m_seaglass, verts=64, r_top=1.4, parent=p_whale)
    add_cyl("WhaleBasinWater", (0, 0, .63), 1.33, .04, m_pearl, verts=64, bevel_w=0, parent=p_whale)
    # Wave crest the whale rises from: two curling sweeps, foam pearl over sea glass, tapering to spray.
    for i, (mat_w, r0, a0, h1, rad) in enumerate(((m_seaglass, 1.12, 0.0, 1.45, .3), (m_pearl, 1.0, 2.1, 1.3, .24),
                                                  (m_seaglass, .95, 4.2, 1.2, .22), (m_pearl, .7, 1.0, 1.65, .16), (m_seaglass, .62, 3.4, 1.5, .14))):
        pts = []
        for j in range(11):
            t = j / 10
            a = a0 + t * 2.6
            r = r0 * (1 - .62 * t) + .06
            pts.append((math.cos(a) * r, math.sin(a) * r, .62 + (h1 - .62) * math.sin(t * math.pi * .6) - .25 * t * t))
        add_tube(f"WhaleWave_{i}", pts, rad, mat_w, res_u=12, bevel_res=4, taper_end=.1, parent=p_whale)
    return whale


# ==============================================================================
# PART 1: PLAYABLE COASTAL ROWBOAT + ARTICULATED OARS
# ==============================================================================
def build_rowboat_glb():
    clear_scene()
    m_teak = make_mat("Boat_Teak", "#8e5a36", rough=0.52, coat=0.22)
    m_cedar = make_mat("Boat_Cedar", "#b98456", rough=0.58, coat=0.14)
    m_cream = make_mat("Boat_CreamHull", "#efe6d2", rough=0.46, coat=0.25)
    m_seaglass = make_mat("Boat_SeaGlass", "#2d7c82", rough=0.44, coat=0.26)
    m_brass = make_mat("Boat_Brass", "#d49c45", rough=0.28, metal=0.82, coat=0.2)
    m_rope = make_mat("Boat_Rope", "#cbb282", rough=0.82, coat=0.0)
    m_cushion = make_mat("Boat_Cushion", "#386b7a", rough=0.72, coat=0.05)
    m_glow = make_mat("Boat_LanternGlow", "#ffd584", rough=0.22, emission_hex="#ffbe55", emission_strength=2.4)

    hull_root = bpy.data.objects.new("Rowboat_Hull", None)
    bpy.context.collection.objects.link(hull_root)

    # Hull profile: bow at y = -2.02 (Three.js +Z = +2.02), stern at y = +1.82 (Three.js -Z = -1.82)
    # Waterline is z = 0.0; keel bottom z = -0.22; sheer gunwale rises to +0.66 at bow and +0.52 at stern.
    stations = 26
    strakes = 7  # from keel center (0) up to sheer gunwale (1)

    def hull_half_beam(u):
        # u = 0 at bow (y = -2.02), u = 1 at stern (y = +1.82)
        if u < 0.52:
            t = u / 0.52
            return 0.72 * math.sin(t * math.pi * 0.5) ** 0.72
        else:
            t = (u - 0.52) / 0.48
            # Graceful wineglass transom narrowing to 0.44m half-beam at stern
            return 0.72 * (1.0 - 0.39 * (t ** 1.55))

    def hull_sheer_z(u):
        bow_lift = 0.20 * ((1.0 - min(1.0, u / 0.42)) ** 1.8)
        stern_lift = 0.09 * (max(0.0, (u - 0.62) / 0.38) ** 1.6)
        return 0.45 + bow_lift + stern_lift

    def hull_keel_z(u):
        bow_rocker = 0.16 * ((1.0 - min(1.0, u / 0.22)) ** 2.0)
        stern_rocker = 0.10 * (max(0.0, (u - 0.78) / 0.22) ** 1.8)
        return -0.21 + bow_rocker + stern_rocker

    # Build thick double-sided lofted clinker hull (outer + inner shell)
    bm = bmesh.new()
    outer_grid = []
    inner_grid = []
    wall_thick = 0.036

    for i in range(stations + 1):
        u = i / stations
        y = -2.02 + u * 3.84
        hb = max(0.018, hull_half_beam(u))
        z_top = hull_sheer_z(u)
        z_bot = hull_keel_z(u)
        # Cross-section ring from starboard sheer (-X) -> keel (0) -> port sheer (+X)
        ring_out = []
        ring_in = []
        pts_half = []
        for s in range(strakes + 1):
            v = s / strakes  # 0 = keel, 1 = sheer
            # Lapstrake subtle stepped flare
            lap = 0.008 * ((s % 2) - 0.5) if 0 < s < strakes else 0.0
            x = hb * (math.sin(v * math.pi * 0.5) ** 0.68) + lap
            z = z_bot + (z_top - z_bot) * (v ** 1.28)
            pts_half.append((x, z))
        # Full cross-section from -X sheer to +X sheer
        full = [(-x, z) for x, z in reversed(pts_half[1:])] + pts_half
        for x, z in full:
            nx = -1.0 if x < -0.02 else (1.0 if x > 0.02 else 0.0)
            ix = x - nx * wall_thick * (0.85 if abs(x) > 0.08 else 0.0)
            iz = z + wall_thick * (1.0 - 0.45 * abs(nx))
            ring_out.append(bm.verts.new((x, y, z)))
            ring_in.append(bm.verts.new((ix * 0.94, y + (0.04 if i == 0 else (-0.04 if i == stations else 0.0)), iz)))
        outer_grid.append(ring_out)
        inner_grid.append(ring_in)

    ncols = len(outer_grid[0])
    for i in range(stations):
        for j in range(ncols - 1):
            # Outer hull faces
            f1 = bm.faces.new((outer_grid[i][j], outer_grid[i + 1][j], outer_grid[i + 1][j + 1], outer_grid[i][j + 1]))
            # Inner hull faces (reversed winding)
            f2 = bm.faces.new((inner_grid[i][j], inner_grid[i][j + 1], inner_grid[i + 1][j + 1], inner_grid[i + 1][j]))
        # Gunwale cap rim (starboard j=0 and port j=ncols-1)
        bm.faces.new((outer_grid[i][0], inner_grid[i][0], inner_grid[i + 1][0], outer_grid[i + 1][0]))
        bm.faces.new((outer_grid[i][ncols - 1], outer_grid[i + 1][ncols - 1], inner_grid[i + 1][ncols - 1], inner_grid[i][ncols - 1]))

    # Close stern transom (i = stations) and bow stem (i = 0)
    for j in range(ncols - 1):
        bm.faces.new((outer_grid[stations][j], inner_grid[stations][j], inner_grid[stations][j + 1], outer_grid[stations][j + 1]))
        bm.faces.new((outer_grid[0][j], outer_grid[0][j + 1], inner_grid[0][j + 1], inner_grid[0][j]))
    # Solid transom back plate
    mid_s = ncols // 2
    bm.faces.new((outer_grid[stations][mid_s - 1], outer_grid[stations][mid_s + 1], outer_grid[stations][mid_s]))
    bm.faces.new((inner_grid[stations][mid_s - 1], inner_grid[stations][mid_s], inner_grid[stations][mid_s + 1]))
    for d in range(2, mid_s + 1):
        bm.faces.new((outer_grid[stations][mid_s - d], outer_grid[stations][mid_s + d],
                      outer_grid[stations][mid_s + d - 1], outer_grid[stations][mid_s - d + 1]))
        bm.faces.new((inner_grid[stations][mid_s - d], inner_grid[stations][mid_s - d + 1],
                      inner_grid[stations][mid_s + d - 1], inner_grid[stations][mid_s + d]))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    hull_me = bpy.data.meshes.new("HullShell")
    bm.to_mesh(hull_me)
    bm.free()
    hull_ob = bpy.data.objects.new("HullShell", hull_me)
    bpy.context.collection.objects.link(hull_ob)
    assign_mat(hull_ob, m_cream)
    shade_smooth(hull_ob)
    hull_ob.parent = hull_root

    # Decorative sea-glass sheer stripe + warm teak gunwale rails + keel skeg
    for side in (-1, 1):
        stripe_pts = []
        gunwale_pts = []
        for i in range(stations + 1):
            u = i / stations
            y = -2.02 + u * 3.84
            hb = max(0.02, hull_half_beam(u))
            zt = hull_sheer_z(u)
            gunwale_pts.append((side * (hb + 0.015), y, zt + 0.012))
            stripe_pts.append((side * (hb * 0.965), y, zt - 0.085))
        add_tube(f"Gunwale_{side}", gunwale_pts, 0.032, m_teak, res_u=6, parent=hull_root)
        add_tube(f"SheerStripe_{side}", stripe_pts, 0.022, m_seaglass, res_u=6, parent=hull_root)

    keel_pts = [(0.0, -2.04, 0.62), (0.0, -1.94, 0.12), (0.0, -1.55, -0.22), (0.0, 0.0, -0.25), (0.0, 1.55, -0.20), (0.0, 1.84, 0.02), (0.0, 1.86, 0.50)]
    add_tube("KeelSpine", keel_pts, 0.034, m_teak, res_u=6, parent=hull_root)

    # Steam-bent interior oak ribs
    for u in (0.18, 0.29, 0.40, 0.51, 0.62, 0.73, 0.84):
        y = -2.02 + u * 3.84
        hb = hull_half_beam(u) * 0.90
        zt = hull_sheer_z(u) - 0.03
        zb = hull_keel_z(u) + 0.045
        rib_pts = [
            (-hb, y, zt),
            (-hb * 0.78, y, zb + (zt - zb) * 0.35),
            (0.0, y, zb),
            (hb * 0.78, y, zb + (zt - zb) * 0.35),
            (hb, y, zt),
        ]
        add_tube(f"Rib_{u:.2f}", rib_pts, 0.018, m_cedar, res_u=5, parent=hull_root)

    # Slatted cedar floorboards (duckboards) at z = +0.03
    for idx, x_off in enumerate((-0.24, -0.12, 0.0, 0.12, 0.24)):
        length = 2.45 - abs(x_off) * 1.4
        add_box(f"FloorSlat_{idx}", (x_off, -0.02, 0.03), (0.088, length, 0.024), m_cedar, bevel_w=0.005, parent=hull_root)

    # Bow breasthook deck + Stern quarter knees
    add_box("BowBreasthook", (0.0, -1.68, 0.54), (0.52, 0.52, 0.036), m_teak, bevel_w=0.01, parent=hull_root)
    add_box("SternTransomCap", (0.0, 1.80, 0.51), (0.88, 0.09, 0.042), m_teak, bevel_w=0.01, parent=hull_root)

    # Three sculpted thwarts (benches):
    # 1) Rower center thwart at y = +0.18 (Three.js z = -0.18), top z = 0.36
    add_box("CenterThwart", (0.0, 0.18, 0.34), (1.28, 0.34, 0.042), m_teak, bevel_w=0.01, parent=hull_root)
    add_box("RowerCushion", (0.0, 0.18, 0.375), (0.64, 0.28, 0.038), m_cushion, bevel_w=0.012, parent=hull_root)
    # 2) Forward passenger bench at y = -0.90 (Three.js z = +0.90), top z = 0.36
    add_box("PassengerThwart", (0.0, -0.90, 0.34), (1.06, 0.34, 0.042), m_teak, bevel_w=0.01, parent=hull_root)
    add_box("PassengerCushion", (0.0, -0.90, 0.375), (0.62, 0.28, 0.04), m_cushion, bevel_w=0.012, parent=hull_root)
    # 3) Stern seat at y = +1.34 (Three.js z = -1.34), top z = 0.38
    add_box("SternThwart", (0.0, 1.34, 0.36), (0.94, 0.42, 0.042), m_teak, bevel_w=0.01, parent=hull_root)

    # Coiled mooring rope on bow deck + stern brass cleat
    for turn in range(3):
        r = 0.09 + turn * 0.028
        pts = [(r * math.cos(a), -1.62 + r * math.sin(a), 0.572) for a in [k * math.tau / 18 for k in range(18)]]
        add_tube(f"BowRopeCoil_{turn}", pts, 0.013, m_rope, res_u=4, cyclic=True, parent=hull_root)
    add_cyl("BowStemFitting", (0.0, -1.96, 0.65), 0.028, 0.12, m_brass, verts=14, parent=hull_root)
    add_box("SternCleatBar", (0.0, 1.78, 0.555), (0.18, 0.032, 0.024), m_brass, bevel_w=0.005, parent=hull_root)

    # Swan-neck brass bow lantern at y = -1.88, z = 0.80
    add_tube("LanternBracket", [(0.0, -1.78, 0.56), (0.0, -1.86, 0.78), (0.0, -1.95, 0.86), (0.0, -1.98, 0.79)], 0.014, m_brass, res_u=6, parent=hull_root)
    add_cyl("LanternCap", (0.0, -1.98, 0.76), 0.068, 0.035, m_brass, verts=12, r_top=0.02, parent=hull_root)
    add_cyl("LanternGlass", (0.0, -1.98, 0.695), 0.052, 0.095, m_glow, verts=12, bevel_w=0.0, parent=hull_root)
    add_cyl("LanternBase", (0.0, -1.98, 0.638), 0.062, 0.028, m_brass, verts=12, parent=hull_root)

    # Port (+X) & Starboard (-X) Brass U-Oarlocks at (x = Â±0.68, y = -0.24, z = 0.53) -> Three.js (Â±0.68, 0.53, +0.24)
    for side in (-1, 1):
        ox, oy, oz = side * 0.68, -0.24, 0.505
        add_cyl(f"OarlockSocket_{side}", (ox, oy, oz - 0.02), 0.026, 0.055, m_brass, verts=12, parent=hull_root)
        u_pts = [
            (ox, oy - 0.038, oz + 0.055),
            (ox, oy - 0.032, oz + 0.01),
            (ox, oy, oz),
            (ox, oy + 0.032, oz + 0.01),
            (ox, oy + 0.038, oz + 0.055),
        ]
        add_tube(f"OarlockHorn_{side}", u_pts, 0.011, m_brass, res_u=5, parent=hull_root)

    batch_children_by_material(hull_root)

    # Articulated Oars: Oar_L (+0.68, -0.24, 0.53) and Oar_R (-0.68, -0.24, 0.53)
    # Local origin (0,0,0) IS the oarlock pivot!
    for label, side in (("Oar_L", 1), ("Oar_R", -1)):
        oar_root = bpy.data.objects.new(label, None)
        oar_root.location = (side * 0.68, -0.24, 0.53)
        bpy.context.collection.objects.link(oar_root)

        # Oar axis tilts gently outward & downward by 15 degrees so blade reaches water cleanly
        # Inboard grip at local x = -side * 0.42, z = +0.05 (so world X = side * 0.26, Y = 0.58)
        # Outboard blade tip at local x = +side * 1.56, z = -0.42
        ux, uz = side * math.cos(math.radians(15.0)), -math.sin(math.radians(15.0))
        # Leather collar at oarlock (0,0,0)
        add_cyl(f"{label}_Collar", (0, 0, 0), 0.028, 0.11, m_brass, verts=14,
                rot=(0, math.radians(90 * side + (-15 * side)), 0), parent=oar_root)
        # Main tapered wooden shaft from grip (-0.45) to neck (+1.02)
        shaft_pts = [
            (-ux * 0.46, 0.0, -uz * 0.46),
            (0.0, 0.0, 0.0),
            (ux * 0.55, 0.0, uz * 0.55),
            (ux * 1.04, 0.0, uz * 1.04),
        ]
        add_tube(f"{label}_Shaft", shaft_pts, 0.021, m_cedar, res_u=6, taper_end=0.82, parent=oar_root)
        # Ergonomic turned teak handle grip at inboard end (-0.36 .. -0.48)
        grip_pts = [
            (-ux * 0.34, 0.0, -uz * 0.34),
            (-ux * 0.42, 0.0, -uz * 0.42),
            (-ux * 0.49, 0.0, -uz * 0.49),
        ]
        add_tube(f"{label}_Grip", grip_pts, 0.024, m_teak, res_u=4, taper_end=0.9, parent=oar_root)
        # Sculpted spoon oar blade from +1.02 to +1.58 along (ux, 0, uz)
        blade_center = (ux * 1.30, 0.0, uz * 1.30)
        blade_rot = (0.0, math.radians(15.0 * side), 0.0)
        add_box(f"{label}_BladeBody", blade_center, (0.56, 0.155, 0.018), m_cream, rot=blade_rot, bevel_w=0.007, parent=oar_root)
        tip_center = (ux * 1.50, 0.0, uz * 1.50)
        add_box(f"{label}_BladeTip", tip_center, (0.16, 0.158, 0.020), m_seaglass, rot=blade_rot, bevel_w=0.006, parent=oar_root)

        # Batch each oar's meshes in oar_root's local space while keeping oar_root's world location at the oarlock!
        saved_loc = oar_root.location.copy()
        oar_root.location = (0, 0, 0)
        bpy.context.view_layer.update()
        # Move children to local coords first
        for ch in list(oar_root.children):
            ch.parent = None
        bpy.context.view_layer.update()
        for ch in [o for o in bpy.context.scene.objects if o.name.startswith(label + "_")]:
            ch.parent = oar_root
        bpy.context.view_layer.update()
        batch_children_by_material(oar_root)
        oar_root.location = saved_loc
        bpy.context.view_layer.update()

    temp = OUT / "rowboat.pending.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(temp),
        export_format="GLB",
        export_yup=True,
        export_cameras=False,
        export_lights=False,
    )
    digest = hashlib.sha256(temp.read_bytes()).hexdigest()[:12]
    target = OUT / f"rowboat-{digest}.glb"
    temp.replace(target)
    return target


# ==============================================================================
# PART 2: ARCHIPELAGO LANDMARKS, DOCKS, BOTANICALS & INTERACTIVE PROPS
# ==============================================================================
def build_archipelago_props_glb():
    clear_scene()
    rng = random.Random(4026)

    # Shared coastal material palette (minimizes unique materials across the entire prop kit!)
    m_teak = make_mat("Arch_Teak", "#845332", rough=0.56, coat=0.16)
    m_cedar = make_mat("Arch_Cedar", "#ad7c50", rough=0.62, coat=0.10)
    m_driftwood = make_mat("Arch_Driftwood", "#8a7e6e", rough=0.76, coat=0.04)
    m_stone = make_mat("Arch_Travertine", "#dfd5c0", rough=0.62, coat=0.08)
    m_slate = make_mat("Arch_SeaSlate", "#2c4c57", rough=0.46, coat=0.20)
    m_seaglass = make_mat("Arch_SeaGlass", "#37858b", rough=0.38, coat=0.28)
    m_pearl = make_mat("Arch_Pearl", "#f4eee0", rough=0.36, coat=0.30)
    m_brass = make_mat("Arch_Brass", "#d39b43", rough=0.30, metal=0.80, coat=0.22)
    m_iron = make_mat("Arch_Iron", "#2d353c", rough=0.48, metal=0.68, coat=0.10)
    m_rope = make_mat("Arch_Rope", "#cab07e", rough=0.84, coat=0.0)
    m_bark = make_mat("Arch_PalmBark", "#7a5e46", rough=0.9, coat=0.0)
    m_frond = make_mat("Arch_TropicalLeaf", "#3d8649", rough=0.8, coat=0.0)
    m_frond_light = make_mat("Arch_SunLeaf", "#6ab04c", rough=0.8, coat=0.0)
    m_coral_bloom = make_mat("Arch_CoralBloom", "#e45d6d", rough=0.7, coat=0.0)
    m_gold_bloom = make_mat("Arch_SunBloom", "#f2b84b", rough=0.7, coat=0.0)
    atlas = foliage_atlas()
    m_cards = foliage_material(atlas)
    m_beacon_glow = make_mat("Beacon_Glass", "#ffe09a", rough=0.20, emission_hex="#ffc15e", emission_strength=3.2)
    m_book_red = make_mat("Arch_BookCoral", "#b54845", rough=0.62, coat=0.08)
    m_book_navy = make_mat("Arch_BookNavy", "#294866", rough=0.62, coat=0.08)

    roots = []

    def new_prop(name):
        e = bpy.data.objects.new(name, None)
        bpy.context.collection.objects.link(e)
        roots.append(e)
        return e

    # 1. Prop_DockModule: 4.0m long (-2..+2 Y), 2.4m wide (-1.2..+1.2 X), deck top at Z = 0.0!
    p_dock = new_prop("Prop_DockModule")
    ox = p_dock.location.x
    # Two longitudinal heavy stringer beams
    for sx in (-0.92, 0.0, 0.92):
        add_box(f"DockStringer_{sx}", (ox + sx, 0.0, -0.14), (0.16, 3.98, 0.18), m_teak, bevel_w=0.012, parent=p_dock)
    # 14 individual beveled deck planks across X so the pier looks authentically timber-built
    for i in range(14):
        py = -1.86 + i * (3.72 / 13.0)
        mat_p = m_cedar if i % 3 != 0 else m_driftwood
        add_box(f"DockPlank_{i}", (ox, py, -0.028), (2.36, 0.245, 0.056), mat_p, bevel_w=0.008, parent=p_dock)
    # Side rub-rails + corner timber pilings going into seabed (-2.5m to +0.58m)
    for sx in (-1.18, 1.18):
        add_box(f"DockCurb_{sx}", (ox + sx, 0.0, 0.03), (0.09, 3.98, 0.11), m_teak, bevel_w=0.01, parent=p_dock)
        for sy in (-1.65, 1.65):
            add_cyl(f"DockPiling_{sx}_{sy}", (ox + sx * 0.98, sy, -0.96), 0.135, 3.10, m_teak, verts=14, parent=p_dock)
            add_cyl(f"PilingCap_{sx}_{sy}", (ox + sx * 0.98, sy, 0.61), 0.148, 0.05, m_brass, verts=14, r_top=0.09, parent=p_dock)
            # Rope wrap collar on piling top
            for k in range(2):
                add_cyl(f"PilingRope_{sx}_{sy}_{k}", (ox + sx * 0.98, sy, 0.44 + k * 0.035), 0.146, 0.028, m_rope, verts=14, parent=p_dock)

    # 2. Prop_MooringBollard: Harbor stone plinth + cast-brass twin-horn bollard + rope coil
    p_bol = new_prop("Prop_MooringBollard")
    ox = p_bol.location.x
    add_cyl("BolPlinth", (ox, 0, 0.06), 0.30, 0.12, m_stone, verts=16, parent=p_bol)
    add_cyl("BolBody", (ox, 0, 0.30), 0.13, 0.40, m_iron, verts=16, r_top=0.11, parent=p_bol)
    add_cyl("BolCap", (ox, 0, 0.52), 0.155, 0.06, m_brass, verts=16, parent=p_bol)
    add_cyl("BolHorn", (ox, 0, 0.44), 0.038, 0.44, m_brass, verts=12, rot=(0, math.radians(90), 0), parent=p_bol)
    for k in range(3):
        r = 0.16 + k * 0.03
        pts = [(ox + r * math.cos(a), r * math.sin(a), 0.135 + k * 0.018) for a in [j * math.tau / 16 for j in range(16)]]
        add_tube(f"BolCoil_{k}", pts, 0.018, m_rope, res_u=4, cyclic=True, parent=p_bol)

    # 3. Prop_HarborBeacon: 3.15m coastal stone & bronze harbor lamp with warm toggleable glass
    p_bea = new_prop("Prop_HarborBeacon")
    ox = p_bea.location.x
    add_cyl("BeaFoot", (ox, 0, 0.16), 0.38, 0.32, m_stone, verts=8, r_top=0.30, parent=p_bea)
    add_cyl("BeaPlinth", (ox, 0, 0.48), 0.25, 0.36, m_stone, verts=12, r_top=0.18, parent=p_bea)
    add_cyl("BeaCollar", (ox, 0, 0.69), 0.20, 0.07, m_brass, verts=16, parent=p_bea)
    add_cyl("BeaShaft", (ox, 0, 1.62), 0.068, 1.82, m_slate, verts=14, r_top=0.052, parent=p_bea)
    # Curved swan-neck bracket holding suspended coastal lantern at y = -0.28 (forward)
    add_tube("BeaArm", [(ox, 0, 2.42), (ox, -0.06, 2.78), (ox, -0.24, 2.96), (ox, -0.34, 2.82)], 0.026, m_brass, res_u=6, parent=p_bea)
    add_cyl("BeaLanternRoof", (ox, -0.34, 2.74), 0.21, 0.11, m_brass, verts=8, r_top=0.04, parent=p_bea)
    add_cyl("BeaLanternGlass", (ox, -0.34, 2.56), 0.145, 0.26, m_beacon_glow, verts=8, bevel_w=0.0, parent=p_bea)
    add_cyl("BeaLanternBase", (ox, -0.34, 2.41), 0.165, 0.05, m_brass, verts=8, r_top=0.12, parent=p_bea)

    # 4. Prop_SpeakingKiosk: Interactive English Conversation Noticeboard / Speaking Totem
    p_kiosk = new_prop("Prop_SpeakingKiosk")
    ox = p_kiosk.location.x
    add_box("KioskBase", (ox, 0, 0.08), (1.68, 0.62, 0.16), m_stone, bevel_w=0.02, parent=p_kiosk)
    for sx in (-0.68, 0.68):
        add_cyl(f"KioskPost_{sx}", (ox + sx, 0, 1.08), 0.072, 1.92, m_teak, verts=12, parent=p_kiosk)
        add_cyl(f"KioskCollar_{sx}", (ox + sx, 0, 0.22), 0.092, 0.12, m_brass, verts=12, parent=p_kiosk)
    # Pitched sea-glass ceramic canopy roof
    for side in (-1, 1):
        add_box(f"KioskRoof_{side}", (ox, side * 0.19, 2.12), (1.92, 0.46, 0.055), m_seaglass,
                rot=(math.radians(24 * side), 0, 0), bevel_w=0.01, parent=p_kiosk)
    add_cyl("KioskRidge", (ox, 0, 2.24), 0.045, 1.96, m_brass, verts=12, rot=(0, math.radians(90), 0), parent=p_kiosk)
    # Framed cedar board + slate backing + parchment prompt cards on both front (-Y) and back (+Y)
    add_box("KioskFrame", (ox, 0, 1.32), (1.30, 0.11, 0.96), m_cedar, bevel_w=0.015, parent=p_kiosk)
    add_box("KioskSlate", (ox, 0, 1.32), (1.18, 0.13, 0.84), m_slate, bevel_w=0.008, parent=p_kiosk)
    for face_s in (-1, 1):
        add_box(f"KioskHeader_{face_s}", (ox, face_s * 0.072, 1.64), (0.96, 0.02, 0.11), m_brass, bevel_w=0.004, parent=p_kiosk)
        # Two brass corner pins only, outside the plaque (1.12 x 0.62 centred at z 1.30): nothing under or over its face.
        for cx in (-0.6, 0.6):
            add_sphere(f"KioskPin_{face_s}_{cx}", (ox + cx, face_s * 0.068, 1.70), (0.022, 0.012, 0.022), m_brass, segs=10, rings=6, parent=p_kiosk)
    add_sphere("KioskLamp", (ox, -0.14, 1.88), (0.065, 0.065, 0.065), m_beacon_glow, parent=p_kiosk)

    # 5. Prop_DirectionalSign: Coastal fingerpost sign pointing to islands
    p_sign = new_prop("Prop_DirectionalSign")
    ox = p_sign.location.x
    add_cyl("SignStone", (ox, 0, 0.12), 0.32, 0.24, m_stone, verts=10, r_top=0.25, parent=p_sign)
    add_cyl("SignPost", (ox, 0, 1.30), 0.065, 2.25, m_teak, verts=12, r_top=0.052, parent=p_sign)
    add_sphere("SignFinial", (ox, 0, 2.48), (0.09, 0.09, 0.09), m_brass, parent=p_sign)
    for idx, (ang, z_h, mat_b) in enumerate(((25, 2.22, m_seaglass), (-42, 2.02, m_cedar), (118, 1.82, m_pearl), (-135, 1.62, m_cedar))):
        rad = math.radians(ang)
        dx, dy = math.cos(rad) * 0.36, math.sin(rad) * 0.36
        add_box(f"SignBlade_{idx}", (ox + dx, dy, z_h), (0.76, 0.045, 0.135), mat_b, rot=(0, 0, rad), bevel_w=0.008, parent=p_sign)

    # 6. Prop_PalmCluster: Curved twin coconut palms with 18 arched pinnate fronds
    p_palm = new_prop("Prop_PalmCluster")
    ox = p_palm.location.x
    add_sphere("PalmBaseMound", (ox, 0, 0.06), (0.72, 0.68, 0.22), m_stone, parent=p_palm)
    for p_idx, (lean_x, lean_y, height, frond_n, f_len) in enumerate(((0.42, -0.32, 5.4, 11, 2.25), (-0.55, 0.36, 3.7, 8, 1.68))):
        trunk_pts = [
            (ox + lean_x * 0.05, lean_y * 0.05, 0.0),
            (ox + lean_x * 0.35, lean_y * 0.30, height * 0.34),
            (ox + lean_x * 0.78, lean_y * 0.72, height * 0.68),
            (ox + lean_x, lean_y, height),
        ]
        add_tube(f"PalmTrunk_{p_idx}", trunk_pts, 0.165 if p_idx == 0 else 0.125, m_bark, res_u=7, taper_end=0.58, parent=p_palm)
        top = Vector((ox + lean_x, lean_y, height))
        # Coconuts
        for c_i in range(3):
            ca = c_i * math.tau / 3.0 + p_idx
            add_sphere(f"Coconut_{p_idx}_{c_i}", (top.x + math.cos(ca) * 0.14, top.y + math.sin(ca) * 0.14, top.z - 0.12),
                       (0.095, 0.095, 0.11), m_teak, segs=10, rings=8, parent=p_palm)
        # Fronds: one drooping, gently folded strip each, carrying the painted leaflets of the atlas (u 0..0.5).
        quads = []
        for f_i in range(frond_n):
            az = f_i * math.tau / frond_n + p_idx * 0.7 + (0.18 if f_i % 2 else -0.12)
            pitch_up = 0.42 if f_i % 3 == 0 else (0.18 if f_i % 3 == 1 else -0.05)
            segs = 8
            rows = []
            for s_ in range(segs + 1):
                t = s_ / segs
                dist = f_len * 1.1 * t
                lift = math.sin(t * math.pi * 0.62) * (0.48 + pitch_up) - (t ** 2.1) * 0.85
                w = 0.62 * math.sin(math.pi * min(1.0, t * 0.9 + 0.1)) * (1.0 - 0.2 * t) + .05
                cx = top.x + math.cos(az) * dist
                cy = top.y + math.sin(az) * dist
                cz = top.z + lift
                px, py = -math.sin(az) * w, math.cos(az) * w
                fold = .16 * w
                rows.append(((cx + px, cy + py, cz - fold), (cx, cy, cz + .02), (cx - px, cy - py, cz - fold), t))
            for s_ in range(segs):
                a0, a1 = rows[s_], rows[s_ + 1]
                v0, v1 = a0[3], a1[3]
                quads.append(((a0[0], a1[0], a1[1], a0[1]), ((0.0, v0), (0.0, v1), (0.25, v1), (0.25, v0))))
                quads.append(((a0[1], a1[1], a1[2], a0[2]), ((0.25, v0), (0.25, v1), (0.5, v1), (0.5, v0))))
        card_mesh(f"Fronds_{p_idx}", quads, m_cards, p_palm)

    # 7. Prop_TropicalShrub: leafy dome of broad leaf cards with bougainvillea bracts, on a dark core (footprint ~0.8 m)
    p_shrub = new_prop("Prop_TropicalShrub")
    ox = p_shrub.location.x
    m_core = make_mat("Arch_ShrubShade", "#1f4a2b", rough=0.95, coat=0.0)
    for k in range(4):
        ang = k * math.tau / 4.0
        add_sphere(f"ShrubCore_{k}", (ox + math.cos(ang) * .18, math.sin(ang) * .18, .3), (.26, .25, .24), m_core, segs=8, rings=6, parent=p_shrub)
    quads = []
    for k in range(140):
        bloom = k % 4 == 0 and k > 20
        el = math.acos(1 - rng.uniform(0, 1) * .95)
        az = rng.uniform(0, math.tau)
        rad = rng.uniform(.28, .66)
        n = Vector((math.sin(el) * math.cos(az), math.sin(el) * math.sin(az), math.cos(el))).normalized()
        c = Vector((ox, 0, .3)) + Vector((n.x * rad, n.y * rad * .95, n.z * rad * .8 + .05))
        up = (Vector((0, 0, 1)) - n * n.z).normalized() if abs(n.z) < .98 else Vector((1, 0, 0))
        up.rotate(Matrix.Rotation(rng.uniform(-.6, .6), 3, n))
        side = n.cross(up).normalized()
        size = rng.uniform(.3, .46) * (.8 if bloom else 1)
        hw, hh = size * .5, size * .5
        corners = [tuple(c - side * hw - up * hh * .2), tuple(c + side * hw - up * hh * .2), tuple(c + side * hw + up * hh * 1.8), tuple(c - side * hw + up * hh * 1.8)]
        u0, v0 = .5, (.5 if bloom else 0.0)
        quads.append((corners, ((u0, v0), (u0 + .5, v0), (u0 + .5, v0 + .5), (u0, v0 + .5))))
    card_mesh("ShrubCards", quads, m_cards, p_shrub)

    # 8. Prop_LibraryShelf: Open-air coastal bookcase + reading lectern with colorful cloth-bound books
    p_lib = new_prop("Prop_LibraryShelf")
    ox = p_lib.location.x
    add_box("LibPlinth", (ox, 0, 0.08), (1.76, 0.58, 0.16), m_stone, bevel_w=0.02, parent=p_lib)
    for sx in (-0.78, 0.78):
        add_box(f"LibSide_{sx}", (ox + sx, 0, 1.08), (0.09, 0.46, 1.88), m_teak, bevel_w=0.01, parent=p_lib)
    add_box("LibCanopy", (ox, 0, 2.05), (1.92, 0.64, 0.09), m_teak, bevel_w=0.015, parent=p_lib)
    add_box("LibBack", (ox, 0.20, 1.08), (1.52, 0.04, 1.82), m_cedar, bevel_w=0.008, parent=p_lib)
    book_mats = (m_book_red, m_book_navy, m_seaglass, m_gold_bloom, m_pearl)
    for shelf_z in (0.48, 0.98, 1.48):
        add_box(f"LibShelf_{shelf_z}", (ox, 0.0, shelf_z), (1.50, 0.42, 0.045), m_teak, bevel_w=0.006, parent=p_lib)
        bx_cursor = -0.64
        b_i = 0
        while bx_cursor < 0.56:
            bw = rng.uniform(0.048, 0.078)
            bh = rng.uniform(0.24, 0.34)
            tilt = rng.uniform(-0.08, 0.08) if b_i % 5 == 4 else 0.0
            add_box(f"Book_{shelf_z}_{b_i}", (ox + bx_cursor + bw * 0.5, 0.02, shelf_z + 0.025 + bh * 0.5),
                    (bw * 0.92, 0.24, bh), book_mats[(b_i + int(shelf_z * 10)) % len(book_mats)],
                    rot=(0, tilt, 0), bevel_w=0.004, parent=p_lib)
            bx_cursor += bw + (0.04 if b_i % 6 == 3 else 0.006)
            b_i += 1

    # 9. Prop_ObservatoryAstrolabe: Sunset Observatory brass maritime telescope & armillary sphere on stone pedestal
    p_obs = new_prop("Prop_ObservatoryAstrolabe")
    ox = p_obs.location.x
    add_cyl("ObsBase", (ox, 0, 0.10), 0.44, 0.20, m_stone, verts=16, r_top=0.36, parent=p_obs)
    add_cyl("ObsPillar", (ox, 0, 0.62), 0.16, 0.86, m_stone, verts=12, r_top=0.12, parent=p_obs)
    add_cyl("ObsYoke", (ox, 0, 1.12), 0.14, 0.14, m_brass, verts=16, parent=p_obs)
    # Armillary meridian ring + brass spyglass barrel angled 18 deg toward horizon (-Y)
    ring_pts = [(ox, 0.34 * math.cos(a), 1.36 + 0.34 * math.sin(a)) for a in [j * math.tau / 24 for j in range(24)]]
    add_tube("ObsRing", ring_pts, 0.018, m_brass, res_u=4, cyclic=True, parent=p_obs)
    add_cyl("ObsTubeMain", (ox, -0.08, 1.38), 0.068, 0.96, m_brass, verts=18, r_top=0.042,
            rot=(math.radians(72.0), 0, 0), parent=p_obs)
    add_cyl("ObsLensHood", (ox, -0.54, 1.53), 0.076, 0.14, m_slate, verts=18,
            rot=(math.radians(72.0), 0, 0), parent=p_obs)
    add_cyl("ObsEyepiece", (ox, 0.38, 1.23), 0.036, 0.16, m_brass, verts=14,
            rot=(math.radians(72.0), 0, 0), parent=p_obs)

    # 10. Prop_HarborCargo: Coopered barrel, shipping crate, woven seagrass basket & rolled sail
    p_cargo = new_prop("Prop_HarborCargo")
    ox = p_cargo.location.x
    add_box("CargoCrate", (ox - 0.32, 0.12, 0.32), (0.64, 0.64, 0.64), m_cedar, rot=(0, 0, 0.14), bevel_w=0.012, parent=p_cargo)
    add_cyl("CargoBarrel", (ox + 0.34, -0.10, 0.38), 0.27, 0.76, m_teak, verts=16, parent=p_cargo)
    for hz in (0.14, 0.38, 0.62):
        add_cyl(f"BarrelHoop_{hz}", (ox + 0.34, -0.10, hz), 0.282, 0.032, m_iron, verts=16, parent=p_cargo)
    add_cyl("CargoBasket", (ox + 0.06, -0.48, 0.20), 0.22, 0.40, m_rope, verts=14, r_top=0.27, parent=p_cargo)
    add_cyl("RolledSail", (ox - 0.28, 0.12, 0.74), 0.11, 0.88, m_pearl, verts=14, rot=(0, math.radians(90), 0.25), parent=p_cargo)

    # 11. Prop_WhaleSculpture: Echo breaching from a wave crest on a travertine plinth (footprint radius 1.9 m)
    p_whale = new_prop("Prop_WhaleSculpture")
    build_whale_monument(p_whale, m_stone, m_seaglass, m_pearl, m_brass)

    # Center EVERY prop root at (0,0,0) in local space so Three.js can clone/instance each named prop directly at world (0,0,0)!
    for root in roots:
        batch_children_by_material(root)
        root.location = (0.0, 0.0, 0.0)
    bpy.context.view_layer.update()

    temp = OUT / "archipelago-props.pending.glb"
    bpy.ops.export_scene.gltf(
        filepath=str(temp),
        export_format="GLB",
        export_yup=True,
        export_cameras=False,
        export_lights=False,
    )
    digest = hashlib.sha256(temp.read_bytes()).hexdigest()[:12]
    target = OUT / f"archipelago-props-{digest}.glb"
    temp.replace(target)
    return target


if __name__ == "__main__":
    boat_glb = build_rowboat_glb()
    props_glb = build_archipelago_props_glb()
    manifest = {
        "generator": "scripts/speaking/build_archipelago_assets.py",
        "blender": bpy.app.version_string,
        "rowboat": {
            "file": boat_glb.name,
            "bytes": boat_glb.stat().st_size,
            "sha256": hashlib.sha256(boat_glb.read_bytes()).hexdigest(),
        },
        "props": {
            "file": props_glb.name,
            "bytes": props_glb.stat().st_size,
            "sha256": hashlib.sha256(props_glb.read_bytes()).hexdigest(),
        },
    }
    (OUT / "archipelago-assets-source.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("ARCHIPELAGO_ASSETS_BUILT:", json.dumps(manifest, indent=2))
