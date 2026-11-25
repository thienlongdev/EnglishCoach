#!/usr/bin/env python3
"""
ECHO ARCHIPELAGO v7 — Headless Blender 4.2.16 LTS Cycles OptiX 3D Asset Studio & QA Renderer
Owner: dept_environment_assets

Produces 28 high-craft tropical archipelago 3D assets + 4 tileable PBR material sets in a scratch
raw staging directory for post-processing by `scripts/speaking/optimize_archipelago_v7_glb.mjs`,
and renders Cycles OptiX studio turnaround tiles in `--qa-sheet` mode.

Strict Guarantees:
- Read-only external vaults (`C:\\ECHO_LIFE_3D_ASSET_FACTORY`, `C:\\ECHO_LIFE_CODEX_ASSET_STUDIO`).
- Hardware-accelerated Cycles `OPTIX` GPU baking on NVIDIA GeForce RTX 5070.
- 4-pass metallic-safe PBR baking (Tangent Normal + Ray-Traced AO + Pure Albedo + Roughness/Metallic ORM).
- Foliage strictly uses `blend_method = 'CLIP'` (`alphaMode: MASK`, `doubleSided: True`) — zero `BLEND` sorting bugs.
- Preserves exact vessel & prop runtime node hierarchies (`Rowboat_Hull`, `Oar_L`, `Oar_R`, `Hull`,
  `SteeringWheel`, `Outboard`, `Propeller`, `Fruit_Coconut`, `Fruit_Mango`, `Fruit_Banana`, `Fruit_Papaya`).
"""

import argparse
import io
import json
import math
import os
import random
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

REPO_ROOT = Path(__file__).resolve().parents[2]
FACTORY_ROOT = Path(r"C:\ECHO_LIFE_3D_ASSET_FACTORY")
CODEX_STUDIO_ROOT = Path(r"C:\ECHO_LIFE_CODEX_ASSET_STUDIO")
WHALE_SOURCE_GLB = REPO_ROOT / "frontend" / "public" / "models" / "whale-e0569b41.glb"

POLYHAVEN_MODELS = FACTORY_ROOT / "22_SOURCE_ASSETS_PRIVATE" / "polyhaven_models"
FACTORY_NATURE = FACTORY_ROOT / "10_NATURE_AND_LANDSCAPE"
POLYHAVEN_TEXTURES = FACTORY_ROOT / "22_SOURCE_ASSETS_PRIVATE" / "polyhaven_textures"
KENNEY_WATERCRAFT_ZIP = CODEX_STUDIO_ROOT / "24_PRIVATE_SOURCE_FILES" / "wave03" / "watercraft-kit.zip"
CLARENS_HDR = FACTORY_ROOT / "12_LIGHTING_AND_ENVIRONMENT" / "clarens_midday_1k.hdr"


# ==============================================================================
# 1. CYCLES OPTIX STUDIO INITIALIZATION & CORE HELPERS
# ==============================================================================
def setup_cycles_optix():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    optix_found = False
    for dev in prefs.devices:
        use_it = dev.type == "OPTIX" and ("RTX" in dev.name or "NVIDIA" in dev.name)
        dev.use = use_it
        if use_it:
            optix_found = True
    if not optix_found:
        for dev in prefs.devices:
            if dev.type in ("OPTIX", "CUDA"):
                dev.use = True

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU"
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPTIX"
    scene.cycles.max_bounces = 4
    scene.cycles.diffuse_bounces = 2
    scene.cycles.glossy_bounces = 2
    scene.render.bake.use_clear = True
    scene.render.bake.margin = 8
    scene.render.bake.margin_type = "EXTEND"
    scene.render.bake.normal_space = "TANGENT"
    scene.render.bake.normal_r = "POS_X"
    scene.render.bake.normal_g = "POS_Y"
    scene.render.bake.normal_b = "POS_Z"

    # White ambient world for clean normalized Cycles AO baking
    world = bpy.data.worlds.new("BakeWorld")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (1.0, 1.0, 1.0, 1.0)
        bg.inputs["Strength"].default_value = 1.0
    scene.world = world
    return scene


def clear_scene_keep_shared(keep_images=None, keep_mats=None):
    keep_images = set(keep_images or [])
    keep_mats = set(keep_mats or [])
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for me in list(bpy.data.meshes):
        if me.users == 0:
            bpy.data.meshes.remove(me)
    for cu in list(bpy.data.curves):
        if cu.users == 0:
            bpy.data.curves.remove(cu)
    for ar in list(bpy.data.armatures):
        if ar.users == 0:
            bpy.data.armatures.remove(ar)
    for mat in list(bpy.data.materials):
        if mat not in keep_mats and mat.users == 0:
            bpy.data.materials.remove(mat)
    for img in list(bpy.data.images):
        if img not in keep_images and img.users == 0:
            bpy.data.images.remove(img)


def hex_to_linear(hex_str):
    h = hex_str.lstrip("#")
    srgb = [int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4)]
    return tuple(((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in srgb)


def ensure_gltf_ao_group():
    ng = bpy.data.node_groups.get("glTF Material Output")
    if ng is None:
        ng = bpy.data.node_groups.new("glTF Material Output", "ShaderNodeTree")
        ng.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    return ng


def pack_np_image(name, arr_u8, colorspace="sRGB"):
    h, w, c = arr_u8.shape
    img = bpy.data.images.new(name=name, width=w, height=h, alpha=(c == 4))
    img.colorspace_settings.name = colorspace
    if c == 3:
        rgba = np.ones((h, w, 4), dtype=np.float32)
        rgba[:, :, :3] = np.flipud(arr_u8).astype(np.float32) / 255.0
    else:
        rgba = np.flipud(arr_u8).astype(np.float32) / 255.0
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def dilate_alpha_rgb(rgba_f32, passes=10):
    """Bleed foreground RGB outward into transparent pixels to prevent dark/white mipmap fringes on MASK foliage."""
    out = rgba_f32.copy()
    mask = out[:, :, 3] > 0.35
    rgb = out[:, :, :3].copy()
    for _ in range(passes):
        acc = np.zeros_like(rgb)
        cnt = np.zeros(mask.shape, dtype=np.float32)
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
            m_shift = np.roll(np.roll(mask, dy, axis=0), dx, axis=1)
            c_shift = np.roll(np.roll(rgb, dy, axis=0), dx, axis=1)
            acc += c_shift * m_shift[..., None]
            cnt += m_shift.astype(np.float32)
        fill = (~mask) & (cnt > 0)
        rgb[fill] = acc[fill] / np.maximum(cnt[fill, None], 1.0)
        mask = mask | fill
    out[:, :, :3] = rgb
    return out


def height_to_normal_u8(height_f32, strength=4.0):
    dhx = (np.roll(height_f32, -1, axis=1) - np.roll(height_f32, 1, axis=1)) * 0.5 * strength
    dhy = (np.roll(height_f32, -1, axis=0) - np.roll(height_f32, 1, axis=0)) * 0.5 * strength
    nx, ny, nz = -dhx, -dhy, np.ones_like(dhx)
    inv = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-12)
    return np.stack(
        [
            np.round(np.clip(nx * inv * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8),
            np.round(np.clip(ny * inv * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8),
            np.round(np.clip(nz * inv * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8),
        ],
        axis=-1,
    )


def make_baked_gltf_mat(
    name,
    alb_img,
    nor_img,
    orm_img,
    double_sided=False,
    alpha_clip=False,
    alpha_cutoff=0.44,
    nor_str=1.0,
    emissive_rgb=None,
    emissive_strength=0.0,
):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.use_backface_culling = not double_sided
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    if alb_img is not None:
        t_alb = nt.nodes.new("ShaderNodeTexImage")
        t_alb.image = alb_img
        nt.links.new(t_alb.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha_clip:
            nt.links.new(t_alb.outputs["Alpha"], bsdf.inputs["Alpha"])
            mat.blend_method = "CLIP"
            mat.alpha_threshold = alpha_cutoff

    if nor_img is not None:
        t_nor = nt.nodes.new("ShaderNodeTexImage")
        t_nor.image = nor_img
        nrm = nt.nodes.new("ShaderNodeNormalMap")
        nrm.inputs["Strength"].default_value = nor_str
        nt.links.new(t_nor.outputs["Color"], nrm.inputs["Color"])
        nt.links.new(nrm.outputs["Normal"], bsdf.inputs["Normal"])

    if orm_img is not None:
        t_orm = nt.nodes.new("ShaderNodeTexImage")
        t_orm.image = orm_img
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(t_orm.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        gltf_node = nt.nodes.new("ShaderNodeGroup")
        gltf_node.node_tree = ensure_gltf_ao_group()
        nt.links.new(sep.outputs["Red"], gltf_node.inputs["Occlusion"])

    if emissive_rgb is not None and emissive_strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = (*emissive_rgb, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emissive_strength

    return mat


def make_fresnel_glass_mat(name="Marine_FresnelGlass", hex_tint="#8ec8d2", alpha=0.30):
    """Zero-transmission physical Schlick-style alpha glass (prevents 2x scene transmission pass!)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.blend_method = "BLEND"
    mat.use_backface_culling = False
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    lin = hex_to_linear(hex_tint)
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.08
    bsdf.inputs["Metallic"].default_value = 0.14
    bsdf.inputs["Alpha"].default_value = alpha
    return mat


# ==============================================================================
# 2. PROCEDURAL CYCLES SHADER GRAPH + 4-PASS METALLIC-SAFE OPTIX ATLAS BAKER
# ==============================================================================
def make_proc_mat(
    name,
    base_hex,
    sec_hex=None,
    rough=0.58,
    metal=0.0,
    grain="wood",
    scale=8.0,
    bump_str=0.32,
    em_hex=None,
    em_str=0.0,
):
    """
    Creates a rich 3D world-space procedural Cycles material equipped with explicit
    ACT_BSDF, ACT_EMIT_COL, and ACT_EMIT_RM outputs for 4-pass metallic-safe baking.
    """
    c1 = hex_to_linear(base_hex)
    c2 = hex_to_linear(sec_hex) if sec_hex else tuple(max(0.0, v * 0.72) for v in c1)

    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.name = "ACT_OUT"
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.name = "ACT_BSDF"
    emit_col = nt.nodes.new("ShaderNodeEmission")
    emit_col.name = "ACT_EMIT_COL"
    emit_rm = nt.nodes.new("ShaderNodeEmission")
    emit_rm.name = "ACT_EMIT_RM"

    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    geom = nt.nodes.new("ShaderNodeNewGeometry")
    tc = nt.nodes.new("ShaderNodeTexCoord")

    if grain == "wood":
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale * 1.4, scale * 0.35, scale * 1.4)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        wv = nt.nodes.new("ShaderNodeTexWave")
        wv.wave_type = "BANDS"
        wv.bands_direction = "X"
        wv.inputs["Scale"].default_value = 3.2
        wv.inputs["Distortion"].default_value = 4.6
        wv.inputs["Detail"].default_value = 6.0
        nt.links.new(mp.outputs["Vector"], wv.inputs["Vector"])
        ns = nt.nodes.new("ShaderNodeTexNoise")
        ns.inputs["Scale"].default_value = scale * 4.5
        ns.inputs["Detail"].default_value = 8.0
        nt.links.new(mp.outputs["Vector"], ns.inputs["Vector"])
        mix_h = nt.nodes.new("ShaderNodeMix")
        mix_h.data_type = "FLOAT"
        mix_h.inputs["Factor"].default_value = 0.35
        nt.links.new(wv.outputs["Fac"], mix_h.inputs["A"])
        nt.links.new(ns.outputs["Fac"], mix_h.inputs["B"])
        fac_sock = mix_h.outputs["Result"]
    elif grain == "bamboo":
        wv1 = nt.nodes.new("ShaderNodeTexWave")
        wv1.inputs["Scale"].default_value = scale * 2.4
        wv1.inputs["Distortion"].default_value = 1.2
        wv1.bands_direction = "X"
        nt.links.new(tc.outputs["Object"], wv1.inputs["Vector"])
        wv2 = nt.nodes.new("ShaderNodeTexWave")
        wv2.inputs["Scale"].default_value = scale * 2.4
        wv2.inputs["Distortion"].default_value = 1.2
        wv2.bands_direction = "Y"
        nt.links.new(tc.outputs["Object"], wv2.inputs["Vector"])
        mx = nt.nodes.new("ShaderNodeMix")
        mx.data_type = "FLOAT"
        mx.inputs["Factor"].default_value = 0.5
        nt.links.new(wv1.outputs["Fac"], mx.inputs["A"])
        nt.links.new(wv2.outputs["Fac"], mx.inputs["B"])
        fac_sock = mx.outputs["Result"]
    elif grain == "thatch":
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale * 2.2, scale * 2.2, scale * 0.6)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        vor = nt.nodes.new("ShaderNodeTexVoronoi")
        vor.feature = "F1"
        vor.inputs["Scale"].default_value = 6.5
        nt.links.new(mp.outputs["Vector"], vor.inputs["Vector"])
        ns = nt.nodes.new("ShaderNodeTexNoise")
        ns.inputs["Scale"].default_value = 16.0
        ns.inputs["Detail"].default_value = 10.0
        nt.links.new(mp.outputs["Vector"], ns.inputs["Vector"])
        mx = nt.nodes.new("ShaderNodeMix")
        mx.data_type = "FLOAT"
        mx.inputs["Factor"].default_value = 0.55
        nt.links.new(vor.outputs["Distance"], mx.inputs["A"])
        nt.links.new(ns.outputs["Fac"], mx.inputs["B"])
        fac_sock = mx.outputs["Result"]
    elif grain == "karst":
        # Stratified Ha Long Bay limestone + vertical rain fluting + Z-height wetline + top moss!
        sep_p = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(geom.outputs["Position"], sep_p.inputs["Vector"])
        sep_n = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(geom.outputs["Normal"], sep_n.inputs["Vector"])

        mp_strata = nt.nodes.new("ShaderNodeMapping")
        mp_strata.inputs["Scale"].default_value = (0.35, 0.35, 1.85)
        nt.links.new(geom.outputs["Position"], mp_strata.inputs["Vector"])
        strata = nt.nodes.new("ShaderNodeTexWave")
        strata.bands_direction = "Z"
        strata.inputs["Scale"].default_value = 2.2
        strata.inputs["Distortion"].default_value = 5.5
        strata.inputs["Detail"].default_value = 8.0
        nt.links.new(mp_strata.outputs["Vector"], strata.inputs["Vector"])

        mp_flute = nt.nodes.new("ShaderNodeMapping")
        mp_flute.inputs["Scale"].default_value = (1.6, 1.6, 0.22)
        nt.links.new(geom.outputs["Position"], mp_flute.inputs["Vector"])
        flute = nt.nodes.new("ShaderNodeTexNoise")
        flute.inputs["Scale"].default_value = 2.6
        flute.inputs["Detail"].default_value = 9.0
        flute.inputs["Roughness"].default_value = 0.68
        nt.links.new(mp_flute.outputs["Vector"], flute.inputs["Vector"])

        vor = nt.nodes.new("ShaderNodeTexVoronoi")
        vor.feature = "DISTANCE_TO_EDGE"
        vor.inputs["Scale"].default_value = 1.8
        nt.links.new(geom.outputs["Position"], vor.inputs["Vector"])

        m1 = nt.nodes.new("ShaderNodeMix")
        m1.data_type = "FLOAT"
        m1.inputs["Factor"].default_value = 0.48
        nt.links.new(strata.outputs["Fac"], m1.inputs["A"])
        nt.links.new(flute.outputs["Fac"], m1.inputs["B"])
        m2 = nt.nodes.new("ShaderNodeMix")
        m2.data_type = "FLOAT"
        m2.inputs["Factor"].default_value = 0.25
        nt.links.new(m1.outputs["Result"], m2.inputs["A"])
        nt.links.new(vor.outputs["Distance"], m2.inputs["B"])
        fac_sock = m2.outputs["Result"]

        # Rock base color + wet dark base (z < 1.3m) + emerald cliffside moss on upward ledges (nz > 0.56 & z > 2.2m)
        rock_mix = nt.nodes.new("ShaderNodeMix")
        rock_mix.data_type = "RGBA"
        rock_mix.inputs["A"].default_value = (*c2, 1.0)
        rock_mix.inputs["B"].default_value = (*c1, 1.0)
        nt.links.new(fac_sock, rock_mix.inputs["Factor"])

        wet_mr = nt.nodes.new("ShaderNodeMapRange")
        wet_mr.inputs["From Min"].default_value = 0.0
        wet_mr.inputs["From Max"].default_value = 1.45
        wet_mr.inputs["To Min"].default_value = 0.68
        wet_mr.inputs["To Max"].default_value = 0.0
        nt.links.new(sep_p.outputs["Z"], wet_mr.inputs["Value"])

        wet_col = nt.nodes.new("ShaderNodeMix")
        wet_col.data_type = "RGBA"
        wet_col.inputs["B"].default_value = (*hex_to_linear("#2b2925"), 1.0)
        nt.links.new(wet_mr.outputs["Result"], wet_col.inputs["Factor"])
        nt.links.new(rock_mix.outputs["Result"], wet_col.inputs["A"])

        moss_n = nt.nodes.new("ShaderNodeMapRange")
        moss_n.inputs["From Min"].default_value = 0.52
        moss_n.inputs["From Max"].default_value = 0.82
        nt.links.new(sep_n.outputs["Z"], moss_n.inputs["Value"])

        moss_z = nt.nodes.new("ShaderNodeMapRange")
        moss_z.inputs["From Min"].default_value = 1.8
        moss_z.inputs["From Max"].default_value = 3.6
        nt.links.new(sep_p.outputs["Z"], moss_z.inputs["Value"])

        moss_fac = nt.nodes.new("ShaderNodeMath")
        moss_fac.operation = "MULTIPLY"
        nt.links.new(moss_n.outputs["Result"], moss_fac.inputs[0])
        nt.links.new(moss_z.outputs["Result"], moss_fac.inputs[1])

        final_col = nt.nodes.new("ShaderNodeMix")
        final_col.data_type = "RGBA"
        final_col.inputs["B"].default_value = (*hex_to_linear("#355828"), 1.0)
        nt.links.new(moss_fac.outputs["Value"], final_col.inputs["Factor"])
        nt.links.new(wet_col.outputs["Result"], final_col.inputs["A"])

        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = bump_str
        bump.inputs["Distance"].default_value = 0.05
        nt.links.new(fac_sock, bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

        nt.links.new(final_col.outputs["Result"], bsdf.inputs["Base Color"])
        nt.links.new(final_col.outputs["Result"], emit_col.inputs["Color"])

        r_wet = nt.nodes.new("ShaderNodeMix")
        r_wet.data_type = "FLOAT"
        r_wet.inputs["A"].default_value = rough
        r_wet.inputs["B"].default_value = 0.28
        nt.links.new(wet_mr.outputs["Result"], r_wet.inputs["Factor"])
        nt.links.new(r_wet.outputs["Result"], bsdf.inputs["Roughness"])
        bsdf.inputs["Metallic"].default_value = 0.0

        comb_rm = nt.nodes.new("ShaderNodeCombineXYZ")
        comb_rm.inputs["X"].default_value = 0.0
        nt.links.new(r_wet.outputs["Result"], comb_rm.inputs["Y"])
        comb_rm.inputs["Z"].default_value = 0.0
        nt.links.new(comb_rm.outputs["Vector"], emit_rm.inputs["Color"])
        return mat
    elif grain == "bronze_patina":
        # Burnished bronze on convex ridges + turquoise verdigris patina in concave crevices
        ns = nt.nodes.new("ShaderNodeTexNoise")
        ns.inputs["Scale"].default_value = scale * 2.5
        ns.inputs["Detail"].default_value = 8.0
        nt.links.new(tc.outputs["Object"], ns.inputs["Vector"])

        pt_mr = nt.nodes.new("ShaderNodeMapRange")
        pt_mr.inputs["From Min"].default_value = 0.44
        pt_mr.inputs["From Max"].default_value = 0.56
        pt_mr.inputs["To Min"].default_value = 1.0  # concave = verdigris patina
        pt_mr.inputs["To Max"].default_value = 0.0  # convex = burnished bronze
        nt.links.new(geom.outputs["Pointiness"], pt_mr.inputs["Value"])

        pat_mix = nt.nodes.new("ShaderNodeMix")
        pat_mix.data_type = "FLOAT"
        pat_mix.inputs["Factor"].default_value = 0.35
        nt.links.new(pt_mr.outputs["Result"], pat_mix.inputs["A"])
        nt.links.new(ns.outputs["Fac"], pat_mix.inputs["B"])

        col_mix = nt.nodes.new("ShaderNodeMix")
        col_mix.data_type = "RGBA"
        col_mix.inputs["A"].default_value = (*c1, 1.0)  # golden burnished bronze
        col_mix.inputs["B"].default_value = (*c2, 1.0)  # turquoise verdigris patina
        nt.links.new(pat_mix.outputs["Result"], col_mix.inputs["Factor"])

        r_mix = nt.nodes.new("ShaderNodeMix")
        r_mix.data_type = "FLOAT"
        r_mix.inputs["A"].default_value = 0.28
        r_mix.inputs["B"].default_value = 0.76
        nt.links.new(pat_mix.outputs["Result"], r_mix.inputs["Factor"])

        m_mix = nt.nodes.new("ShaderNodeMix")
        m_mix.data_type = "FLOAT"
        m_mix.inputs["A"].default_value = 0.88
        m_mix.inputs["B"].default_value = 0.14
        nt.links.new(pat_mix.outputs["Result"], m_mix.inputs["Factor"])

        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = bump_str
        bump.inputs["Distance"].default_value = 0.015
        nt.links.new(ns.outputs["Fac"], bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

        nt.links.new(col_mix.outputs["Result"], bsdf.inputs["Base Color"])
        nt.links.new(col_mix.outputs["Result"], emit_col.inputs["Color"])
        nt.links.new(r_mix.outputs["Result"], bsdf.inputs["Roughness"])
        nt.links.new(m_mix.outputs["Result"], bsdf.inputs["Metallic"])

        comb_rm = nt.nodes.new("ShaderNodeCombineXYZ")
        comb_rm.inputs["X"].default_value = 0.0
        nt.links.new(r_mix.outputs["Result"], comb_rm.inputs["Y"])
        nt.links.new(m_mix.outputs["Result"], comb_rm.inputs["Z"])
        nt.links.new(comb_rm.outputs["Vector"], emit_rm.inputs["Color"])
        return mat
    else:
        # stone / fabric / marine_enamel
        ns = nt.nodes.new("ShaderNodeTexNoise")
        ns.inputs["Scale"].default_value = scale * 3.0
        ns.inputs["Detail"].default_value = 7.0
        ns.inputs["Roughness"].default_value = 0.62
        nt.links.new(tc.outputs["Object"], ns.inputs["Vector"])
        vor = nt.nodes.new("ShaderNodeTexVoronoi")
        vor.feature = "DISTANCE_TO_EDGE" if grain == "stone" else "F1"
        vor.inputs["Scale"].default_value = scale * 1.4
        nt.links.new(tc.outputs["Object"], vor.inputs["Vector"])
        mx = nt.nodes.new("ShaderNodeMix")
        mx.data_type = "FLOAT"
        mx.inputs["Factor"].default_value = 0.38 if grain == "stone" else 0.18
        nt.links.new(ns.outputs["Fac"], mx.inputs["A"])
        nt.links.new(vor.outputs["Distance"], mx.inputs["B"])
        fac_sock = mx.outputs["Result"]

    col_mix = nt.nodes.new("ShaderNodeMix")
    col_mix.data_type = "RGBA"
    col_mix.inputs["A"].default_value = (*c2, 1.0)
    col_mix.inputs["B"].default_value = (*c1, 1.0)
    nt.links.new(fac_sock, col_mix.inputs["Factor"])

    r_mr = nt.nodes.new("ShaderNodeMapRange")
    r_mr.inputs["From Min"].default_value = 0.0
    r_mr.inputs["From Max"].default_value = 1.0
    r_mr.inputs["To Min"].default_value = min(0.98, rough + 0.09)
    r_mr.inputs["To Max"].default_value = max(0.08, rough - 0.08)
    nt.links.new(fac_sock, r_mr.inputs["Value"])

    if bump_str > 0.001:
        bump = nt.nodes.new("ShaderNodeBump")
        bump.inputs["Strength"].default_value = bump_str
        bump.inputs["Distance"].default_value = 0.02
        nt.links.new(fac_sock, bump.inputs["Height"])
        nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    if em_hex and em_str > 0.0:
        ec = hex_to_linear(em_hex)
        bsdf.inputs["Emission Color"].default_value = (*ec, 1.0)
        bsdf.inputs["Emission Strength"].default_value = em_str
        emit_col.inputs["Color"].default_value = (*ec, 1.0)
    else:
        nt.links.new(col_mix.outputs["Result"], emit_col.inputs["Color"])

    nt.links.new(col_mix.outputs["Result"], bsdf.inputs["Base Color"])
    nt.links.new(r_mr.outputs["Result"], bsdf.inputs["Roughness"])
    bsdf.inputs["Metallic"].default_value = metal

    comb_rm = nt.nodes.new("ShaderNodeCombineXYZ")
    comb_rm.inputs["X"].default_value = 1.0 if em_str > 0 else 0.0
    nt.links.new(r_mr.outputs["Result"], comb_rm.inputs["Y"])
    comb_rm.inputs["Z"].default_value = metal
    nt.links.new(comb_rm.outputs["Vector"], emit_rm.inputs["Color"])
    return mat


def bake_objects_to_single_pbr_atlas(mesh_objs, atlas_name, res=1024, ao_samples=20, nor_samples=12):
    """
    Unwraps `mesh_objs` simultaneously into a single non-overlapping [0, 1]^2 Smart-UV space,
    runs 4-pass metallic-safe Cycles OptiX GPU baking on a world-space joined proxy, and assigns
    ONE unified glTF PBR material (Albedo + Normal + ORM) to all `mesh_objs`.
    """
    t0 = time.time()
    mesh_objs = [o for o in mesh_objs if o.type == "MESH" and len(o.data.polygons) > 0]
    for o in mesh_objs:
        if not o.data.uv_layers:
            o.data.uv_layers.new(name="UVMap")
        else:
            o.data.uv_layers[0].name = "UVMap"
            o.data.uv_layers.active_index = 0

    bpy.ops.object.select_all(action="DESELECT")
    for o in mesh_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objs[0]
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(
        angle_limit=math.radians(66.0),
        island_margin=0.008,
        area_weight=0.0,
        correct_aspect=True,
        scale_to_bounds=False,
    )
    bpy.ops.object.mode_set(mode="OBJECT")

    # Build temporary world-space joined BakeProxy
    bpy.context.view_layer.update()
    dups = []
    for o in mesh_objs:
        me_c = o.data.copy()
        me_c.transform(o.matrix_world)
        d = bpy.data.objects.new(f"_bake_dup_{o.name}", me_c)
        bpy.context.collection.objects.link(d)
        dups.append(d)

    bpy.ops.object.select_all(action="DESELECT")
    for d in dups:
        d.select_set(True)
    bpy.context.view_layer.objects.active = dups[0]
    if len(dups) > 1:
        bpy.ops.object.join()
    proxy = bpy.context.view_layer.objects.active
    proxy.name = f"_BakeProxy_{atlas_name}"

    mats = []
    for slot in proxy.material_slots:
        if slot.material and slot.material not in mats:
            mats.append(slot.material)

    def set_mat_mode(mode):
        for m in mats:
            nt = m.node_tree
            out_n = nt.nodes.get("ACT_OUT")
            src_n = nt.nodes.get(mode)
            if out_n and src_n:
                sock_name = "BSDF" if mode == "ACT_BSDF" else "Emission"
                nt.links.new(src_n.outputs[sock_name], out_n.inputs["Surface"])

    def run_pass(btype, colorspace, samples):
        img = bpy.data.images.new(name=f"_tmp_{atlas_name}_{btype}", width=res, height=res, alpha=True)
        img.colorspace_settings.name = colorspace
        tnodes = []
        for m in mats:
            nt = m.node_tree
            for n in nt.nodes:
                n.select = False
            tn = nt.nodes.new("ShaderNodeTexImage")
            tn.image = img
            tn.select = True
            nt.nodes.active = tn
            tnodes.append((nt, tn))

        bpy.ops.object.select_all(action="DESELECT")
        proxy.select_set(True)
        bpy.context.view_layer.objects.active = proxy
        bpy.context.scene.cycles.samples = samples

        if btype == "NORMAL":
            bpy.ops.object.bake(
                type="NORMAL", normal_space="TANGENT", normal_r="POS_X", normal_g="POS_Y", normal_b="POS_Z"
            )
        else:
            bpy.ops.object.bake(type=btype)

        buf = np.empty(res * res * 4, dtype=np.float32)
        img.pixels.foreach_get(buf)
        arr = np.flipud(buf.reshape((res, res, 4)))
        for nt, tn in tnodes:
            nt.nodes.remove(tn)
        bpy.data.images.remove(img)
        return arr

    # Pass 1 & 2: Tangent Normal + Ray-Traced AO
    set_mat_mode("ACT_BSDF")
    nor_rgba = run_pass("NORMAL", "Non-Color", nor_samples)
    ao_rgba = run_pass("AO", "Non-Color", ao_samples)

    # Pass 3: Pure BaseColor (metallic-safe!)
    set_mat_mode("ACT_EMIT_COL")
    alb_rgba = run_pass("EMIT", "sRGB", 2)

    # Pass 4: Roughness (G) + Metallic (B)
    set_mat_mode("ACT_EMIT_RM")
    rm_rgba = run_pass("EMIT", "Non-Color", 2)
    set_mat_mode("ACT_BSDF")

    # Fill unbaked gutter pixels cleanly
    unbaked = nor_rgba[:, :, 3] < 0.05
    nor_rgb = np.clip(nor_rgba[:, :, :3], 0.0, 1.0)
    nor_rgb[unbaked] = np.array([0.5, 0.5, 1.0], dtype=np.float32)

    alb_rgb = np.clip(alb_rgba[:, :, :3], 0.0, 1.0)
    if np.any(~unbaked):
        mean_col = alb_rgb[~unbaked].mean(axis=0)
    else:
        mean_col = np.array([0.5, 0.5, 0.5], dtype=np.float32)
    alb_rgb[unbaked] = mean_col

    # Convert linear baked emission RGB to sRGB uint8 for BaseColor image!
    srgb = np.where(
        alb_rgb <= 0.0031308, alb_rgb * 12.92, 1.055 * np.power(np.maximum(alb_rgb, 0.0), 1.0 / 2.4) - 0.055
    )
    alb_u8 = np.round(np.clip(srgb, 0.0, 1.0) * 255.0).astype(np.uint8)
    nor_u8 = np.round(nor_rgb * 255.0).astype(np.uint8)

    ao_ch = np.clip(ao_rgba[:, :, 0], 0.18, 1.0)
    ao_ch[unbaked] = 1.0
    rough_ch = np.clip(rm_rgba[:, :, 1], 0.08, 0.98)
    rough_ch[unbaked] = 0.65
    metal_ch = np.clip(rm_rgba[:, :, 2], 0.0, 1.0)
    metal_ch[unbaked] = 0.0
    metal_u8 = np.round(metal_ch * 255.0).astype(np.uint8)
    metal_u8[metal_u8 < 16] = 0

    orm_u8 = np.stack(
        [
            np.round(ao_ch * 255.0).astype(np.uint8),
            np.round(rough_ch * 255.0).astype(np.uint8),
            metal_u8,
        ],
        axis=-1,
    )

    # Clean up proxy
    proxy_me = proxy.data
    bpy.data.objects.remove(proxy, do_unlink=True)
    bpy.data.meshes.remove(proxy_me)

    alb_img = pack_np_image(f"{atlas_name}_Albedo", alb_u8, "sRGB")
    nor_img = pack_np_image(f"{atlas_name}_Normal", nor_u8, "Non-Color")
    orm_img = pack_np_image(f"{atlas_name}_ORM", orm_u8, "Non-Color")

    gltf_mat = make_baked_gltf_mat(f"{atlas_name}_PBR", alb_img, nor_img, orm_img)
    for o in mesh_objs:
        o.data.materials.clear()
        o.data.materials.append(gltf_mat)
        for p in o.data.polygons:
            p.material_index = 0

    print(f"[optix-bake] {atlas_name} ({res}px) baked in {time.time() - t0:.2f}s", flush=True)
    return gltf_mat


# ==============================================================================
# 3. BOTANICAL FOLIAGE, BARK & NET TEXTURE SYNTHESIS (ALPHA-DILATED MASK)
# ==============================================================================
def build_shared_botanical_textures():
    """Builds shared 1024px Palm Frond, 4-Quadrant Tropical Foliage, Coconut/Royal Bark, and Fishing Net PBR maps."""
    t0 = time.time()
    shared = {}

    # --- A. 1024x1024 Pinnate Palm Frond (MASK, Alpha-Dilated + 3D Vein Normal + ORM) ---
    S = 1024
    frond_rgba = np.zeros((S, S, 4), dtype=np.float32)
    frond_h = np.zeros((S, S), dtype=np.float32)
    rng = random.Random(7701)

    def stamp_ellipse(rgba, hmap, cx, cy, rx, ry, ang, rgb_top, rgb_edge, ridge=0.4):
        H_im, W_im = hmap.shape
        pad = int(max(rx, ry)) + 3
        x0, x1 = max(0, int(cx - pad)), min(W_im, int(cx + pad))
        y0, y1 = max(0, int(cy - pad)), min(H_im, int(cy + pad))
        if x1 <= x0 or y1 <= y0:
            return
        yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32) + 0.5
        c, s = math.cos(ang), math.sin(ang)
        dx, dy = xx - cx, yy - cy
        u = (dx * c + dy * s) / max(rx, 1e-3)
        v = (-dx * s + dy * c) / max(ry, 1e-3)
        d = np.sqrt(u * u + v * v)
        alpha = np.clip((1.0 - d) * min(rx, ry) * 0.85 + 0.5, 0.0, 1.0)
        vein = np.clip(1.0 - np.abs(v) * 2.1, 0.0, 1.0)
        col = np.array(rgb_edge, np.float32)[None, None, :] * (1.0 - vein[..., None]) + np.array(
            rgb_top, np.float32
        )[None, None, :] * vein[..., None]
        reg = rgba[y0:y1, x0:x1]
        m = alpha > reg[:, :, 3]
        reg[:, :, :3] = np.where(m[..., None], col, reg[:, :, :3])
        reg[:, :, 3] = np.maximum(reg[:, :, 3], alpha)
        h_reg = hmap[y0:y1, x0:x1]
        hmap[y0:y1, x0:x1] = np.maximum(h_reg, alpha * (0.25 + ridge * vein))

    # Central golden-olive rachis stem from bottom (y=18) to tip (y=995)
    for k in range(110):
        t = k / 109.0
        cy = 18 + t * (S - 38)
        rw = 12.0 * (1.0 - 0.78 * t) + 1.8
        stamp_ellipse(frond_rgba, frond_h, S * 0.5, cy, rw, 11.0, math.pi * 0.5, (0.52, 0.58, 0.24), (0.34, 0.42, 0.16), 0.85)

    # 38 arched pinnate leaflet pairs
    for k in range(38):
        t = k / 37.0
        base_y = 54 + t * (S - 96)
        L = (S * 0.43) * math.sin(math.pi * (0.10 + 0.86 * t)) * (1.0 - 0.18 * t) + 28.0
        W = 13.5 * (1.0 - 0.36 * t) + 3.5
        for side in (-1, 1):
            ang_deg = 66.0 - 34.0 * t + rng.uniform(-3.0, 3.0)
            ang = math.radians(ang_deg) if side > 0 else math.pi - math.radians(ang_deg)
            cx = S * 0.5 + math.cos(ang) * L * 0.48
            cy = base_y + math.sin(ang) * L * 0.48
            g_top = 0.46 + 0.18 * t + rng.uniform(-0.03, 0.03)
            stamp_ellipse(
                frond_rgba,
                frond_h,
                cx,
                cy,
                L * 0.52,
                W,
                ang,
                (0.20 + 0.11 * t, g_top, 0.12 + 0.04 * t),
                (0.10 + 0.06 * t, g_top * 0.70, 0.08),
                0.55,
            )

    frond_dil = dilate_alpha_rgb(frond_rgba, passes=12)
    frond_u8 = np.round(np.clip(frond_dil, 0, 1) * 255).astype(np.uint8)
    frond_nor_u8 = height_to_normal_u8(frond_h, strength=4.5)
    frond_orm_u8 = np.stack(
        [
            np.round(np.clip(0.58 + 0.42 * frond_h, 0.45, 1.0) * 255).astype(np.uint8),
            np.round(np.clip(0.56 - 0.16 * frond_h, 0.34, 0.72) * 255).astype(np.uint8),
            np.zeros((S, S), dtype=np.uint8),
        ],
        axis=-1,
    )
    shared["palm_frond_mat"] = make_baked_gltf_mat(
        "V7_PalmFrond_Mask",
        pack_np_image("V7_PalmFrond_Alb", frond_u8, "sRGB"),
        pack_np_image("V7_PalmFrond_Nor", frond_nor_u8, "Non-Color"),
        pack_np_image("V7_PalmFrond_ORM", frond_orm_u8, "Non-Color"),
        double_sided=True,
        alpha_clip=True,
        alpha_cutoff=0.42,
    )

    # --- B. 1024x1024 4-Quadrant Tropical Botanical Atlas ---
    # Q0 (u:0..0.5, v:0..0.5): Mango glossy branchlet
    # Q1 (u:0.5..1, v:0..0.5): Banana broad split paddle leaf
    # Q2 (u:0..0.5, v:0.5..1): Bougainvillea coral-magenta bracts + leaves
    # Q3 (u:0.5..1, v:0.5..1): Hibiscus sunlit-gold blossoms + leaves
    bot_rgba = np.zeros((S, S, 4), dtype=np.float32)
    bot_h = np.zeros((S, S), dtype=np.float32)
    H = S // 2

    # Q0 (bottom-left in UV -> rows 0..512, cols 0..512): Mango lanceolate whorl
    stamp_ellipse(bot_rgba, bot_h, 256, 130, 8, 110, math.pi * 0.5, (0.34, 0.26, 0.16), (0.24, 0.18, 0.11), 0.6)
    for k in range(11):
        ang = math.radians(22 + k * 13.6 + rng.uniform(-4, 4))
        L = rng.uniform(145, 205)
        cx, cy = 256 + math.cos(ang) * L * 0.54, 72 + math.sin(ang) * L * 0.54
        flush = k in (0, 10)
        top_c = (0.38, 0.44, 0.16) if flush else (0.14, 0.38, 0.14)
        edg_c = (0.26, 0.32, 0.10) if flush else (0.08, 0.25, 0.09)
        stamp_ellipse(bot_rgba, bot_h, cx, cy, L * 0.52, L * 0.16, ang, top_c, edg_c, 0.55)

    # Q1 (bottom-right: cols 512..1024, rows 0..512): Banana split paddle leaf
    stamp_ellipse(bot_rgba, bot_h, 768, 256, 11, 238, math.pi * 0.5, (0.55, 0.68, 0.24), (0.38, 0.52, 0.18), 0.9)
    for k in range(18):
        if k in (6, 13):
            continue  # natural wind splits in banana paddle!
        t = k / 17.0
        by = 48 + t * 415
        w_rib = 175 * math.sin(math.pi * (0.12 + 0.82 * t)) + 28
        for side in (-1, 1):
            ang = math.radians(10 * side) if side > 0 else math.pi - math.radians(10)
            cx = 768 + side * w_rib * 0.50
            stamp_ellipse(
                bot_rgba,
                bot_h,
                cx,
                by,
                w_rib * 0.52,
                16.5,
                0.08 * side,
                (0.24, 0.56, 0.18),
                (0.16, 0.42, 0.13),
                0.42,
            )

    # Q2 (top-left: cols 0..512, rows 512..1024): Bougainvillea coral-magenta & green leaves
    for k in range(20):
        ang = rng.uniform(0, math.tau)
        r = rng.uniform(25, 175)
        stamp_ellipse(
            bot_rgba,
            bot_h,
            256 + math.cos(ang) * r,
            768 + math.sin(ang) * r,
            46,
            24,
            ang,
            (0.16, 0.42, 0.16),
            (0.09, 0.28, 0.10),
            0.4,
        )
    for k in range(58):
        ang = rng.uniform(0, math.tau)
        r = (rng.uniform(0, 1) ** 0.75) * 190
        cx, cy = 256 + math.cos(ang) * r, 768 + math.sin(ang) * r
        bract = (0.88, 0.16, 0.46) if k % 3 else (0.95, 0.34, 0.36)
        for p in range(3):
            pa = p * math.tau / 3.0 + rng.uniform(0, 0.8)
            stamp_ellipse(
                bot_rgba,
                bot_h,
                cx + math.cos(pa) * 10,
                cy + math.sin(pa) * 10,
                16,
                11,
                pa,
                bract,
                (bract[0] * 0.78, bract[1] * 0.72, bract[2] * 0.78),
                0.5,
            )
        stamp_ellipse(bot_rgba, bot_h, cx, cy, 4.2, 4.2, 0, (0.98, 0.95, 0.78), (0.90, 0.84, 0.55), 0.7)

    # Q3 (top-right: cols 512..1024, rows 512..1024): Hibiscus sunlit-gold blooms + glossy leaves
    for k in range(24):
        ang = rng.uniform(0, math.tau)
        r = rng.uniform(25, 180)
        stamp_ellipse(
            bot_rgba,
            bot_h,
            768 + math.cos(ang) * r,
            768 + math.sin(ang) * r,
            50,
            26,
            ang,
            (0.15, 0.44, 0.15),
            (0.08, 0.28, 0.09),
            0.45,
        )
    for k in range(18):
        ang = k * 2.39996
        r = 28 + (k / 18.0) * 155
        cx, cy = 768 + math.cos(ang) * r, 768 + math.sin(ang) * r
        for p in range(5):
            pa = p * math.tau / 5.0 + k * 0.3
            stamp_ellipse(
                bot_rgba,
                bot_h,
                cx + math.cos(pa) * 15,
                cy + math.sin(pa) * 15,
                21,
                15,
                pa,
                (0.98, 0.76, 0.16),
                (0.92, 0.44, 0.10),
                0.55,
            )
        stamp_ellipse(bot_rgba, bot_h, cx, cy, 6.5, 6.5, 0, (0.82, 0.18, 0.14), (0.62, 0.10, 0.08), 0.8)

    bot_dil = dilate_alpha_rgb(bot_rgba, passes=12)
    bot_u8 = np.round(np.clip(bot_dil, 0, 1) * 255).astype(np.uint8)
    bot_nor_u8 = height_to_normal_u8(bot_h, strength=4.2)
    bot_orm_u8 = np.stack(
        [
            np.round(np.clip(0.56 + 0.44 * bot_h, 0.44, 1.0) * 255).astype(np.uint8),
            np.round(np.clip(0.52 - 0.18 * bot_h, 0.30, 0.68) * 255).astype(np.uint8),
            np.zeros((S, S), dtype=np.uint8),
        ],
        axis=-1,
    )
    shared["botanical_mat"] = make_baked_gltf_mat(
        "V7_Botanical_Mask",
        pack_np_image("V7_Botanical_Alb", bot_u8, "sRGB"),
        pack_np_image("V7_Botanical_Nor", bot_nor_u8, "Non-Color"),
        pack_np_image("V7_Botanical_ORM", bot_orm_u8, "Non-Color"),
        double_sided=True,
        alpha_clip=True,
        alpha_cutoff=0.42,
    )

    # --- C. 512x512 Coastal Dune Grass Blade Strip (MASK) ---
    G = 512
    gr_rgba = np.zeros((G, G, 4), dtype=np.float32)
    gr_h = np.zeros((G, G), dtype=np.float32)
    for b in range(28):
        bx = 28 + (b / 27.0) * (G - 56) + rng.uniform(-6, 6)
        lean = rng.uniform(-42, 42)
        bh = rng.uniform(310, 485)
        for s_i in range(45):
            t = s_i / 44.0
            px = bx + lean * (t**1.6)
            py = 8 + t * bh
            rad = 6.8 * (1.0 - 0.82 * t) + 1.1
            col_top = (0.34 + 0.24 * t, 0.52 + 0.14 * t, 0.20 + 0.10 * t)
            stamp_ellipse(gr_rgba, gr_h, px, py, rad, 9.0, math.pi * 0.5, col_top, (0.22, 0.36, 0.14), 0.6)
    gr_dil = dilate_alpha_rgb(gr_rgba, passes=8)
    shared["dune_grass_mat"] = make_baked_gltf_mat(
        "V7_DuneGrass_Mask",
        pack_np_image("V7_DuneGrass_Alb", np.round(np.clip(gr_dil, 0, 1) * 255).astype(np.uint8), "sRGB"),
        pack_np_image("V7_DuneGrass_Nor", height_to_normal_u8(gr_h, 3.8), "Non-Color"),
        pack_np_image(
            "V7_DuneGrass_ORM",
            np.stack(
                [
                    np.round(np.clip(0.55 + 0.45 * gr_h, 0.45, 1.0) * 255).astype(np.uint8),
                    np.full((G, G), 158, dtype=np.uint8),
                    np.zeros((G, G), dtype=np.uint8),
                ],
                axis=-1,
            ),
            "Non-Color",
        ),
        double_sided=True,
        alpha_clip=True,
        alpha_cutoff=0.40,
    )

    # --- D. 512x512 Diamond Fishing Net (MASK) ---
    N = 512
    yy, xx = np.mgrid[0:N, 0:N].astype(np.float32) / N
    u_d = (xx + yy) * 14.0
    v_d = (xx - yy) * 14.0
    du = np.abs(u_d - np.round(u_d))
    dv = np.abs(v_d - np.round(v_d))
    line_mask = np.clip(1.0 - np.minimum(du, dv) / 0.13, 0.0, 1.0)
    knot_mask = np.clip(1.0 - np.sqrt(du * du + dv * dv) / 0.19, 0.0, 1.0)
    net_a = np.clip(np.maximum(line_mask > 0.25, knot_mask > 0.25).astype(np.float32), 0.0, 1.0)
    net_h = np.maximum(line_mask * 0.65, knot_mask * 1.0)
    net_rgba = np.zeros((N, N, 4), dtype=np.float32)
    net_rgba[:, :, 0] = 0.22 + 0.34 * knot_mask
    net_rgba[:, :, 1] = 0.48 + 0.16 * knot_mask
    net_rgba[:, :, 2] = 0.46 + 0.10 * knot_mask
    net_rgba[:, :, 3] = net_a
    net_dil = dilate_alpha_rgb(net_rgba, passes=6)
    shared["fishing_net_mat"] = make_baked_gltf_mat(
        "V7_FishingNet_Mask",
        pack_np_image("V7_FishingNet_Alb", np.round(np.clip(net_dil, 0, 1) * 255).astype(np.uint8), "sRGB"),
        pack_np_image("V7_FishingNet_Nor", height_to_normal_u8(net_h, 4.0), "Non-Color"),
        pack_np_image(
            "V7_FishingNet_ORM",
            np.stack(
                [
                    np.round(np.clip(0.65 + 0.35 * net_h, 0.5, 1.0) * 255).astype(np.uint8),
                    np.full((N, N), 205, dtype=np.uint8),
                    np.zeros((N, N), dtype=np.uint8),
                ],
                axis=-1,
            ),
            "Non-Color",
        ),
        double_sided=True,
        alpha_clip=True,
        alpha_cutoff=0.45,
    )

    # --- E. 1024x1024 Cycles-Calibrated Seamless Coconut & Royal Palm Bark Sets ---
    for kind, rings, c_dark, c_mid, c_hi in (
        ("coconut_bark", 11.0, (0.19, 0.13, 0.09), (0.46, 0.35, 0.25), (0.64, 0.53, 0.41)),
        ("royal_bark", 14.0, (0.20, 0.19, 0.17), (0.52, 0.50, 0.46), (0.72, 0.70, 0.65)),
    ):
        yy_b, xx_b = np.mgrid[0:S, 0:S].astype(np.float32) / S
        warp = 0.032 * np.sin(xx_b * math.tau * 2.0) * np.cos(yy_b * math.tau * 2.0) + 0.015 * np.sin(
            xx_b * math.tau * 5.0 + 1.1
        )
        ring_wave = np.sin((yy_b + warp) * math.tau * rings)
        groove = np.clip((ring_wave + 1.0) * 0.5, 0.0, 1.0) ** 0.65
        fibers = (
            0.5
            + 0.28 * np.sin(xx_b * math.tau * 38.0 + np.sin(yy_b * math.tau * 4.0) * 1.6)
            + 0.22 * np.cos(xx_b * math.tau * 71.0 - yy_b * math.tau * 3.0)
        )
        h_bark = np.clip(0.58 * groove + 0.42 * fibers, 0.0, 1.0)
        col_b = np.zeros((S, S, 3), dtype=np.float32)
        for ch in range(3):
            col_b[:, :, ch] = np.where(
                h_bark < 0.45,
                c_dark[ch] + (c_mid[ch] - c_dark[ch]) * (h_bark / 0.45),
                c_mid[ch] + (c_hi[ch] - c_mid[ch]) * ((h_bark - 0.45) / 0.55),
            )
        # Subtle mossy base/crevice tint
        moss_b = np.clip(np.sin(xx_b * math.tau * 3.0 + 0.7) * np.cos(yy_b * math.tau * 2.0) - 0.45, 0.0, 0.35)
        col_b = col_b * (1.0 - moss_b[..., None]) + np.array([0.24, 0.33, 0.18], np.float32)[None, None, :] * moss_b[..., None]
        shared[f"{kind}_mat"] = make_baked_gltf_mat(
            f"V7_{kind}_PBR",
            pack_np_image(f"V7_{kind}_Alb", np.round(np.clip(col_b, 0, 1) * 255).astype(np.uint8), "sRGB"),
            pack_np_image(f"V7_{kind}_Nor", height_to_normal_u8(h_bark, 6.2), "Non-Color"),
            pack_np_image(
                f"V7_{kind}_ORM",
                np.stack(
                    [
                        np.round(np.clip(0.46 + 0.54 * h_bark, 0.42, 1.0) * 255).astype(np.uint8),
                        np.round(np.clip(0.94 - 0.18 * h_bark, 0.70, 0.96) * 255).astype(np.uint8),
                        np.zeros((S, S), dtype=np.uint8),
                    ],
                    axis=-1,
                ),
                "Non-Color",
            ),
        )

    keep_imgs = set(bpy.data.images)
    keep_mats = set(shared.values())
    print(f"[botanical-tex] Synthesized crisp 1K MASK & Bark PBR maps in {time.time() - t0:.2f}s", flush=True)
    return shared, keep_imgs, keep_mats


# ==============================================================================
# 4. GEOMETRY MODELING PRIMITIVES
# ==============================================================================
def make_empty(name, loc=(0, 0, 0), parent=None):
    o = bpy.data.objects.new(name, None)
    o.location = loc
    bpy.context.collection.objects.link(o)
    if parent:
        o.parent = parent
    return o


def add_box(name, loc, dims, mat, rot=(0, 0, 0), bevel_w=0.015, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = dims
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    if bevel_w > 0:
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width = min(bevel_w, min(dims) * 0.28)
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in o.data.polygons:
        p.use_smooth = True
    if parent:
        o.parent = parent
    return o


def add_cyl(name, loc, r_bot, depth, mat, verts=20, r_top=None, rot=(0, 0, 0), bevel_w=0.008, parent=None):
    if r_top is not None:
        bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r_bot, radius2=r_top, depth=depth, location=loc, rotation=rot)
    else:
        bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r_bot, depth=depth, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.data.materials.append(mat)
    if bevel_w > 0:
        mod = o.modifiers.new("Bevel", "BEVEL")
        mod.width = min(bevel_w, depth * 0.22, r_bot * 0.3)
        mod.segments = 2
        mod.limit_method = "ANGLE"
        bpy.ops.object.modifier_apply(modifier=mod.name)
    for p in o.data.polygons:
        p.use_smooth = True
    if parent:
        o.parent = parent
    return o


def add_sphere(name, loc, scale_xyz, mat, segs=18, rings=12, rot=(0, 0, 0), parent=None):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=1.0, location=loc, rotation=rot)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale_xyz
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    o.data.materials.append(mat)
    for p in o.data.polygons:
        p.use_smooth = True
    if parent:
        o.parent = parent
    return o


def add_tube(name, points, radius, mat, res_u=8, bevel_res=2, taper_end=1.0, cyclic=False, parent=None):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = res_u
    curve.bevel_depth = radius
    curve.bevel_resolution = bevel_res
    curve.use_fill_caps = not cyclic
    sp = curve.splines.new("NURBS" if len(points) >= 4 else "POLY")
    sp.points.add(len(points) - 1)
    for i, pt in enumerate(points):
        t = i / max(1, len(points) - 1)
        sp.points[i].co = (pt[0], pt[1], pt[2], 1.0)
        sp.points[i].radius = (1.0 - t) + taper_end * t
    if sp.type == "NURBS":
        sp.use_endpoint_u = not cyclic
        sp.order_u = min(4, len(points))
    sp.use_cyclic_u = cyclic
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    obj.data.materials.append(mat)
    for p in obj.data.polygons:
        p.use_smooth = True
    obj.select_set(False)
    if parent:
        obj.parent = parent
    return obj


def join_children_under_empty(empty_obj, joined_name):
    """Joins all direct MESH children of `empty_obj` into ONE single child MESH in `empty_obj`'s local space."""
    bpy.context.view_layer.update()
    kids = [c for c in list(empty_obj.children) if c.type == "MESH"]
    if not kids:
        return None
    bpy.ops.object.select_all(action="DESELECT")
    for k in kids:
        mw = k.matrix_world.copy()
        k.parent = None
        k.matrix_world = mw
        k.select_set(True)
    bpy.context.view_layer.objects.active = kids[0]
    if len(kids) > 1:
        bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = joined_name
    inv = empty_obj.matrix_world.inverted()
    merged.data.transform(inv @ merged.matrix_world)
    merged.matrix_world = empty_obj.matrix_world.copy()
    merged.parent = empty_obj
    merged.matrix_parent_inverse = Matrix.Identity(4)
    merged.location = (0, 0, 0)
    merged.rotation_euler = (0, 0, 0)
    merged.scale = (1, 1, 1)
    return merged


def ground_all_meshes_to_z0():
    bpy.context.view_layer.update()
    min_z = 1e9
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for o in meshes:
        for v in o.data.vertices:
            wz = (o.matrix_world @ v.co).z
            if wz < min_z:
                min_z = wz
    if min_z < 1e8:
        for o in bpy.context.scene.objects:
            if o.parent is None:
                o.location.z -= min_z
    bpy.context.view_layer.update()


def export_raw_glb(out_path: Path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out_path),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
    )
    print(f"[export-raw] Wrote {out_path.name} ({out_path.stat().st_size / 1024:.1f} KB)", flush=True)


# ==============================================================================
# 5. CATEGORY 1 — TROPICAL VEGETATION KIT (10 ASSETS)
# ==============================================================================
def build_curved_frond_crown(name, top_pos, n_fronds, frond_len, frond_w, mat_frond, seed=101):
    """Creates a realistic 3D V-cambered arched palm crown mesh (single merged primitive, MASK)."""
    rng = random.Random(seed)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    segs = 7

    for i in range(n_fronds):
        tier = i % 3  # 0: lower drooping, 1: mid wide, 2: upper fresh
        az = i * 2.39996 + rng.uniform(-0.12, 0.12)
        pitch0 = math.radians(10 + tier * 22 + rng.uniform(-5, 5))
        droop = math.radians(58 - tier * 14 + rng.uniform(-6, 6))
        L = frond_len * (0.86 + 0.14 * (1 if tier == 1 else 0.92)) * rng.uniform(0.93, 1.07)
        W = frond_w * rng.uniform(0.92, 1.08)
        twist_max = rng.uniform(-0.26, 0.26)

        ca, sa = math.cos(az), math.sin(az)
        fwd = Vector((ca, sa, 0.0))
        side_v = Vector((-sa, ca, 0.0))

        rows = []
        for s in range(segs + 1):
            t = s / segs
            ang = pitch0 - droop * (t**1.45)
            r_horiz = L * t * math.cos(ang * 0.55)
            z_off = L * (math.sin(pitch0) * t - 0.52 * (t**2.05) * math.sin(droop))
            spine = Vector(top_pos) + fwd * r_horiz + Vector((0, 0, z_off))
            w_cur = W * math.sin(math.pi * (0.08 + 0.86 * t)) + 0.04
            v_drop = 0.09 * math.sin(math.pi * t)
            tw = twist_max * t
            lat = (side_v * math.cos(tw) + Vector((0, 0, 1)) * math.sin(tw)) * w_cur
            vL = bm.verts.new(spine - lat - Vector((0, 0, v_drop)))
            vC = bm.verts.new(spine)
            vR = bm.verts.new(spine + lat - Vector((0, 0, v_drop)))
            rows.append((vL, vC, vR, t))

        for s in range(segs):
            vL0, vC0, vR0, t0 = rows[s]
            vL1, vC1, vR1, t1 = rows[s + 1]
            for quad, u0, u1 in (((vL0, vC0, vC1, vL1), 0.02, 0.50), ((vC0, vR0, vR1, vC1), 0.50, 0.98)):
                f = bm.faces.new(quad)
                f.smooth = True
                for lp, uv_pt in zip(f.loops, ((u0, t0), (u1, t0), (u1, t1), (u0, t1))):
                    lp[uv_layer].uv = uv_pt

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat_frond)
    return ob


def build_lofted_trunk(name, spine_pts, radii, mat_bark, sides=16, uv_v_tiles=4.0):
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    rings = []
    n = len(spine_pts)
    for i, (pt, rad) in enumerate(zip(spine_pts, radii)):
        p = Vector(pt)
        if i == 0:
            tan = (Vector(spine_pts[1]) - p).normalized()
        elif i == n - 1:
            tan = (p - Vector(spine_pts[-2])).normalized()
        else:
            tan = (Vector(spine_pts[i + 1]) - Vector(spine_pts[i - 1])).normalized()
        ref = Vector((0, 1, 0)) if abs(tan.y) < 0.9 else Vector((1, 0, 0))
        bx = tan.cross(ref).normalized()
        by = tan.cross(bx).normalized()
        ring = []
        for j in range(sides + 1):
            a = (j / sides) * math.tau
            flare = 1.0 + (0.12 * math.sin(a * 5.0) if i == 0 else 0.0)
            co = p + (bx * math.cos(a) + by * math.sin(a)) * (rad * flare)
            ring.append((bm.verts.new(co), j / sides, (i / (n - 1)) * uv_v_tiles))
        rings.append(ring)

    for i in range(n - 1):
        for j in range(sides):
            v00, u00, w00 = rings[i][j]
            v10, u10, w10 = rings[i][j + 1]
            v11, u11, w11 = rings[i + 1][j + 1]
            v01, u01, w01 = rings[i + 1][j]
            f = bm.faces.new((v00, v10, v11, v01))
            f.smooth = True
            for lp, uv_c in zip(f.loops, ((u00, w00), (u10, w10), (u11, w11), (u01, w01))):
                lp[uv_layer].uv = uv_c

    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.0005)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat_bark)
    return ob


def build_palm_coconut_curved(shared, out_dir: Path):
    pts, rads = [], []
    steps = 22
    for i in range(steps + 1):
        t = i / steps
        # Graceful coastal sweep outward then curving upright toward the sun
        x = 1.38 * math.sin(t * math.pi * 0.72) - 0.18 * (t**2.2)
        y = -0.32 * math.sin(t * math.pi * 0.9)
        z = -0.05 + 7.55 * t
        r = 0.34 * ((1.0 - t) ** 1.8) + 0.135 + (0.09 * ((1.0 - min(1.0, t / 0.12)) ** 2))
        pts.append((x, y, z))
        rads.append(r)

    build_lofted_trunk("CoconutTrunk", pts, rads, shared["coconut_bark_mat"], sides=16, uv_v_tiles=4.5)
    top = pts[-1]

    # Hanging cluster of 6 golden-green & brown coastal coconuts beneath the crown!
    m_coco = make_proc_mat("CocoHusk", "#8d7434", "#5c4220", rough=0.62, grain="thatch", scale=6.0, bump_str=0.25)
    cocos = []
    for k in range(6):
        a = k * math.tau / 6.0 + 0.3
        cx = top[0] + math.cos(a) * 0.24
        cy = top[1] + math.sin(a) * 0.24
        cz = top[2] - 0.18 - (k % 2) * 0.10
        cocos.append(add_sphere(f"Coconut_{k}", (cx, cy, cz), (0.125, 0.125, 0.155), m_coco, segs=12, rings=8))
    bake_objects_to_single_pbr_atlas(cocos, "PalmCocoCluster", res=256, ao_samples=12, nor_samples=8)

    # 22 arching 3D-cambered pinnate fronds
    build_curved_frond_crown("CoconutCrown22", (top[0], top[1], top[2] + 0.10), 22, 3.05, 0.56, shared["palm_frond_mat"], seed=402)
    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / "palm-coconut-curved.glb")


def build_palm_royal_tall(shared, out_dir: Path):
    pts, rads = [], []
    steps = 20
    for i in range(steps + 1):
        t = i / steps
        x = 0.12 * math.sin(t * math.pi)
        z = -0.04 + 6.95 * t
        # Classic Roystonea slight mid-columnar swell
        swell = 0.045 * math.sin(t * math.pi * 0.85)
        r = 0.36 * ((1.0 - min(1.0, t / 0.14)) ** 2) + 0.23 * (1.0 - 0.26 * t) + swell
        pts.append((x, 0.0, z))
        rads.append(r)

    build_lofted_trunk("RoyalTrunk", pts, rads, shared["royal_bark_mat"], sides=18, uv_v_tiles=4.8)

    # Smooth glossy emerald crownshaft (1.55m tall) + small royal palm seed clusters
    m_shaft = make_proc_mat("RoyalCrownshaft", "#3c7a34", "#285822", rough=0.34, grain="wood", scale=4.0, bump_str=0.10)
    shaft_objs = [
        add_cyl("Crownshaft", (0.0, 0.0, 7.68), 0.195, 1.56, m_shaft, verts=18, r_top=0.155, bevel_w=0.01),
    ]
    for side in (-1, 1):
        shaft_objs.append(add_sphere(f"SeedCluster_{side}", (side * 0.24, 0.0, 6.85), (0.14, 0.14, 0.22), m_shaft, segs=10, rings=8))
    bake_objects_to_single_pbr_atlas(shaft_objs, "RoyalShaft", res=256, ao_samples=12, nor_samples=8)

    build_curved_frond_crown("RoyalCrown20", (0.0, 0.0, 8.42), 20, 2.95, 0.58, shared["palm_frond_mat"], seed=808)
    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / "palm-royal-tall.glb")


def build_polyhaven_tree_variant(src_glb: Path, out_name: str, add_banyan_roots: bool, out_dir: Path):
    bpy.ops.import_scene.gltf(filepath=str(src_glb))
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]

    # Fix BLEND -> MASK on all foliage materials & ensure double-sided
    bark_mat = None
    for m in bpy.data.materials:
        if "leaves" in m.name.lower() or "foliage" in m.name.lower():
            m.blend_method = "CLIP"
            m.alpha_threshold = 0.42
            m.use_backface_culling = False
        elif "tree" in m.name.lower() and "branch" not in m.name.lower():
            bark_mat = m

    ground_all_meshes_to_z0()

    if add_banyan_roots and bark_mat is not None:
        # Sculpt 8 tropical banyan aerial prop roots descending from mid limbs into the soil!
        rng = random.Random(912)
        for k in range(8):
            a = k * math.tau / 8.0 + rng.uniform(-0.2, 0.2)
            r_top = rng.uniform(0.75, 1.45)
            r_bot = r_top + rng.uniform(0.15, 0.42)
            z_top = rng.uniform(2.1, 3.2)
            pts = [
                (math.cos(a) * r_top * 0.65, math.sin(a) * r_top * 0.65, z_top + 0.35),
                (math.cos(a) * r_top, math.sin(a) * r_top, z_top * 0.68),
                (math.cos(a) * ((r_top + r_bot) * 0.5), math.sin(a) * ((r_top + r_bot) * 0.5), z_top * 0.30),
                (math.cos(a) * r_bot, math.sin(a) * r_bot, 0.0),
            ]
            r_ob = add_tube(f"BanyanAerialRoot_{k}", pts, rng.uniform(0.038, 0.065), bark_mat, res_u=6, bevel_res=2, taper_end=1.25)
            # Ensure clean cylindrical UVs on aerial root
            if not r_ob.data.uv_layers:
                r_ob.data.uv_layers.new(name="UVMap")

    export_raw_glb(out_dir / f"{out_name}.glb")


def build_quadrant_foliage_cards(name, quads_world, quadrant_idx, mat_bot):
    """quads_world: list of (center, width, height, rot_euler). Maps to quadrant 0..3 of V7_Botanical_Mask (post-flipud)."""
    u0 = 0.02 if (quadrant_idx % 2 == 0) else 0.52
    u1 = 0.48 if (quadrant_idx % 2 == 0) else 0.98
    # Note: pack_np_image applies np.flipud(), placing numpy rows 0..512 (Q0/Q1) at Blender UV v=0.52..0.98
    # and numpy rows 512..1024 (Q2 Bougainvillea / Q3 Hibiscus) at Blender UV v=0.02..0.48!
    v0 = 0.52 if (quadrant_idx < 2) else 0.02
    v1 = 0.98 if (quadrant_idx < 2) else 0.48

    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for ctr, w, h, eul in quads_world:
        rot = Euler(eul, "XYZ").to_matrix()
        c = Vector(ctr)
        camber = rot @ Vector((0, 0.08 * w, 0))
        p0 = c + rot @ Vector((-w * 0.5, 0, 0))
        p1 = c + rot @ Vector((w * 0.5, 0, 0))
        p2 = c + rot @ Vector((w * 0.46, 0, h)) + camber
        p3 = c + rot @ Vector((-w * 0.46, 0, h)) + camber
        vs = [bm.verts.new(p) for p in (p0, p1, p2, p3)]
        f = bm.faces.new(vs)
        f.smooth = True
        for lp, uv_c in zip(f.loops, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
            lp[uv_layer].uv = uv_c

    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(mat_bot)
    return ob


def build_tree_mango_fruiting(shared, out_dir: Path):
    rng = random.Random(515)
    m_bark = make_proc_mat("MangoBark", "#58412e", "#38271a", rough=0.84, grain="wood", scale=6.0, bump_str=0.45)
    m_mango = make_proc_mat("RipeMango", "#f29b24", "#d93829", rough=0.32, grain="stone", scale=4.0, bump_str=0.06)

    solid_objs = []
    # Gnarled trunk + 6 spreading scaffold limbs
    solid_objs.append(
        add_tube(
            "MangoTrunk",
            [(0, 0, -0.04), (0.06, -0.04, 0.95), (-0.04, 0.05, 1.95), (0.0, 0.0, 2.65)],
            0.28,
            m_bark,
            res_u=7,
            bevel_res=3,
            taper_end=0.62,
        )
    )
    cards = []
    for j in range(6):
        a = j * math.tau / 6.0 + 0.25
        r_end = 1.65 + rng.uniform(-0.2, 0.35)
        z_end = 3.55 + rng.uniform(-0.25, 0.45)
        bx, by = math.cos(a) * r_end, math.sin(a) * r_end
        solid_objs.append(
            add_tube(
                f"MangoLimb_{j}",
                [(0, 0, 2.25), (bx * 0.52, by * 0.52, 2.95), (bx, by, z_end)],
                0.13,
                m_bark,
                res_u=6,
                bevel_res=2,
                taper_end=0.38,
            )
        )
        # Dense dome of mango leaf cards around each scaffold limb + central crown
        for k in range(34):
            ba = rng.uniform(0, math.tau)
            el = rng.uniform(-0.25, 1.25)
            rr = rng.uniform(0.35, 1.38)
            lx = bx * 0.85 + math.cos(ba) * math.cos(el) * rr
            ly = by * 0.85 + math.sin(ba) * math.cos(el) * rr
            lz = z_end - 0.15 + math.sin(el) * rr * 0.85
            cards.append(((lx, ly, lz), rng.uniform(0.72, 1.05), rng.uniform(0.78, 1.12), (rng.uniform(-0.7, 0.7), rng.uniform(-0.4, 0.4), ba)))

    # Top central dome cards
    for k in range(36):
        ba = rng.uniform(0, math.tau)
        rr = rng.uniform(0.15, 1.35)
        lz = 4.35 + math.cos(rr / 1.5) * 1.15 + rng.uniform(-0.2, 0.2)
        cards.append(((math.cos(ba) * rr, math.sin(ba) * rr, lz), 0.92, 0.98, (rng.uniform(-0.6, 0.6), 0.0, ba)))

    # 16 visible hanging ripe golden-crimson mangoes on slender stems around lower canopy!
    for m_i in range(16):
        ma = m_i * math.tau / 16.0 + rng.uniform(-0.12, 0.12)
        mr = rng.uniform(1.15, 2.15)
        mz = rng.uniform(2.35, 3.15)
        mx, my = math.cos(ma) * mr, math.sin(ma) * mr
        solid_objs.append(add_cyl(f"MangoStem_{m_i}", (mx, my, mz + 0.16), 0.008, 0.24, m_bark, verts=6, bevel_w=0))
        solid_objs.append(
            add_sphere(f"MangoFruit_{m_i}", (mx, my, mz), (0.085, 0.072, 0.118), m_mango, segs=12, rings=8, rot=(0.12, 0, ma))
        )

    bpy.ops.object.select_all(action="DESELECT")
    for o in solid_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = solid_objs[0]
    bpy.ops.object.join()
    trunk_fruits = bpy.context.view_layer.objects.active
    trunk_fruits.name = "MangoTrunkAndFruits"
    bake_objects_to_single_pbr_atlas([trunk_fruits], "MangoTreeSolid", res=512, ao_samples=16, nor_samples=10)

    build_quadrant_foliage_cards("MangoCanopy", cards, quadrant_idx=0, mat_bot=shared["botanical_mat"])
    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / "tree-mango-fruiting.glb")


def build_tree_banana_fruiting(shared, out_dir: Path):
    rng = random.Random(618)
    m_stem = make_proc_mat("BananaPseudostem", "#6f8c3e", "#4e632a", rough=0.48, grain="wood", scale=5.0, bump_str=0.22)
    m_yellow = make_proc_mat("BananaRipe", "#f2c829", "#c89618", rough=0.38, grain="wood", scale=8.0, bump_str=0.10)
    m_heart = make_proc_mat("BananaBell", "#7a1f34", "#4d1120", rough=0.45, grain="stone", scale=6.0, bump_str=0.14)

    solid = []
    # Main pseudostem + 1 young side sucker shoot
    solid.append(
        add_tube(
            "BananaStemMain",
            [(0, 0, -0.03), (0.04, 0, 1.15), (0.09, 0.02, 2.45)],
            0.165,
            m_stem,
            res_u=7,
            bevel_res=3,
            taper_end=0.68,
        )
    )
    solid.append(
        add_tube(
            "BananaSucker",
            [(-0.28, 0.18, -0.02), (-0.36, 0.24, 0.65), (-0.42, 0.28, 1.25)],
            0.085,
            m_stem,
            res_u=5,
            bevel_res=2,
            taper_end=0.65,
        )
    )

    # Arching fruiting stalk + 3 tiers of ripe yellow bananas + maroon banana heart blossom!
    solid.append(
        add_tube(
            "FruitStalk",
            [(0.09, 0.02, 2.38), (0.36, 0.08, 2.48), (0.52, 0.10, 2.15), (0.54, 0.10, 1.48)],
            0.032,
            m_stem,
            res_u=6,
            bevel_res=2,
            taper_end=0.55,
        )
    )
    for tier in range(3):
        tz = 2.14 - tier * 0.17
        for b_i in range(7):
            ba = b_i * math.tau / 7.0 + tier * 0.4
            bx = 0.53 + math.cos(ba) * 0.09
            by = 0.10 + math.sin(ba) * 0.09
            solid.append(
                add_tube(
                    f"Banana_{tier}_{b_i}",
                    [(bx, by, tz + 0.06), (bx + math.cos(ba) * 0.05, by + math.sin(ba) * 0.05, tz - 0.02), (bx + math.cos(ba) * 0.02, by + math.sin(ba) * 0.02, tz - 0.11)],
                    0.024,
                    m_yellow,
                    res_u=4,
                    bevel_res=1,
                    taper_end=0.65,
                )
            )
    solid.append(add_sphere("BananaHeartBell", (0.54, 0.10, 1.36), (0.075, 0.075, 0.145), m_heart, segs=12, rings=8))

    bpy.ops.object.select_all(action="DESELECT")
    for o in solid:
        o.select_set(True)
    bpy.context.view_layer.objects.active = solid[0]
    bpy.ops.object.join()
    stem_bunch = bpy.context.view_layer.objects.active
    stem_bunch.name = "BananaStemAndBunch"
    bake_objects_to_single_pbr_atlas([stem_bunch], "BananaSolid", res=512, ao_samples=16, nor_samples=10)

    # 12 broad arching split banana paddle leaves (3D cambered ribbons mapped to Q1: u 0.52..0.98, v 0.02..0.48)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for i in range(12):
        is_sucker = i >= 10
        origin = Vector((-0.42, 0.28, 1.22)) if is_sucker else Vector((0.09, 0.02, 2.40 + (i % 3) * 0.06))
        az = i * 2.39996 + 0.4
        L = (1.15 if is_sucker else 2.05) * rng.uniform(0.90, 1.08)
        W = 0.28 if is_sucker else 0.44
        pitch0 = math.radians(42 - (i % 3) * 11)
        droop = math.radians(62)
        ca, sa = math.cos(az), math.sin(az)
        fwd, side_v = Vector((ca, sa, 0)), Vector((-sa, ca, 0))
        rows = []
        for s in range(7):
            t = s / 6.0
            r_h = L * t * 0.92
            z_o = L * (math.sin(pitch0) * t - 0.56 * (t**1.95) * math.sin(droop))
            sp = origin + fwd * r_h + Vector((0, 0, z_o))
            wc = W * math.sin(math.pi * (0.12 + 0.82 * t)) + 0.03
            vd = 0.07 * math.sin(math.pi * t)
            rows.append((bm.verts.new(sp - side_v * wc - Vector((0, 0, vd))), bm.verts.new(sp), bm.verts.new(sp + side_v * wc - Vector((0, 0, vd))), t))
        for s in range(6):
            vL0, vC0, vR0, t0 = rows[s]
            vL1, vC1, vR1, t1 = rows[s + 1]
            for quad, u0, u1 in (((vL0, vC0, vC1, vL1), 0.52, 0.75), ((vC0, vR0, vR1, vC1), 0.75, 0.98)):
                f = bm.faces.new(quad)
                f.smooth = True
                vv0, vv1 = 0.52 + t0 * 0.46, 0.52 + t1 * 0.46
                for lp, uv_c in zip(f.loops, ((u0, vv0), (u1, vv0), (u1, vv1), (u0, vv1))):
                    lp[uv_layer].uv = uv_c

    me = bpy.data.meshes.new("BananaLeaves")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("BananaLeaves", me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(shared["botanical_mat"])

    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / "tree-banana-fruiting.glb")


def build_flowering_bush(slug: str, quadrant_idx: int, seed: int, shared, out_dir: Path):
    rng = random.Random(seed)
    m_stem = make_proc_mat(f"{slug}_Wood", "#5d4631", "#3b2b1d", rough=0.82, grain="wood", scale=8.0, bump_str=0.35)
    stems = []
    cards = []
    for s_i in range(7):
        a = s_i * math.tau / 7.0 + rng.uniform(-0.2, 0.2)
        r = rng.uniform(0.45, 0.78)
        h = rng.uniform(0.85, 1.25)
        stems.append(
            add_tube(
                f"Stem_{s_i}",
                [(0, 0, -0.02), (math.cos(a) * r * 0.45, math.sin(a) * r * 0.45, h * 0.5), (math.cos(a) * r, math.sin(a) * r, h)],
                0.026,
                m_stem,
                res_u=5,
                bevel_res=1,
                taper_end=0.35,
            )
        )
    bpy.ops.object.select_all(action="DESELECT")
    for st in stems:
        st.select_set(True)
    bpy.context.view_layer.objects.active = stems[0]
    bpy.ops.object.join()
    stem_merged = bpy.context.view_layer.objects.active
    stem_merged.name = f"{slug}_Stems"
    bake_objects_to_single_pbr_atlas([stem_merged], f"{slug}_Bark", res=256, ao_samples=10, nor_samples=8)

    for k in range(118):
        a = k * 2.39996
        t = k / 117.0
        rr = (t**0.62) * 0.86 + rng.uniform(-0.06, 0.06)
        zz = 0.16 + (1.0 - (rr / 0.96) ** 1.55) * 1.04 + rng.uniform(-0.08, 0.12)
        cards.append(
            (
                (math.cos(a) * rr, math.sin(a) * rr, max(0.05, zz)),
                rng.uniform(0.48, 0.74),
                rng.uniform(0.48, 0.72),
                (rng.uniform(-0.65, 0.65), rng.uniform(-0.4, 0.4), a + math.pi * 0.5),
            )
        )

    build_quadrant_foliage_cards(f"{slug}_BloomCrown", cards, quadrant_idx=quadrant_idx, mat_bot=shared["botanical_mat"])
    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / f"{slug}.glb")


def build_fern_tropical_cluster(out_dir: Path):
    src = FACTORY_NATURE / "ph_plant_park_fern_clump.glb"
    bpy.ops.import_scene.gltf(filepath=str(src))
    base_meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    for m in bpy.data.materials:
        m.blend_method = "CLIP"
        m.alpha_threshold = 0.44
        m.use_backface_culling = False

    # Add a second slightly smaller rotated fern rosette beside the primary clump for lush rainforest fullness
    for o in list(base_meshes):
        dup = o.copy()
        dup.data = o.data.copy()
        dup.location = o.location + Vector((0.36, 0.24, 0.0))
        dup.rotation_euler = (0.0, 0.0, 2.2)
        dup.scale = o.scale * 0.82
        bpy.context.collection.objects.link(dup)

    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / "fern-tropical-cluster.glb")


def build_grass_beach_dune(shared, out_dir: Path):
    rng = random.Random(309)
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for k in range(26):
        az = k * 2.39996 + rng.uniform(-0.15, 0.15)
        r0 = rng.uniform(0.0, 0.34)
        cx, cy = math.cos(az) * r0, math.sin(az) * r0
        w = rng.uniform(0.36, 0.56)
        h = rng.uniform(0.55, 0.88)
        tilt = rng.uniform(0.18, 0.58)
        rot = Euler((tilt, 0.0, az), "XYZ").to_matrix()
        c = Vector((cx, cy, 0.0))
        p0 = c + rot @ Vector((-w * 0.5, 0, 0))
        p1 = c + rot @ Vector((w * 0.5, 0, 0))
        p2 = c + rot @ Vector((w * 0.45, 0.14 * h, h))
        p3 = c + rot @ Vector((-w * 0.45, 0.14 * h, h))
        vs = [bm.verts.new(p) for p in (p0, p1, p2, p3)]
        f = bm.faces.new(vs)
        f.smooth = True
        for lp, uv_c in zip(f.loops, ((0.02, 0.02), (0.98, 0.02), (0.98, 0.98), (0.02, 0.98))):
            lp[uv_layer].uv = uv_c

    me = bpy.data.meshes.new("BeachDuneGrass")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("BeachDuneGrass", me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(shared["dune_grass_mat"])
    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / "grass-beach-dune.glb")


# ==============================================================================
# 6. CATEGORY 2 — GEOLOGICAL, ARCHITECTURAL & CULTURAL LANDMARKS (8 ASSETS)
# ==============================================================================
def build_karst_spire_tall(out_dir: Path):
    """Dramatic 22m Ha Long Bay striated limestone karst spire with tidal notch & cliffside moss."""
    m_karst = make_proc_mat("HaLongKarst", "#a9a396", "#58534a", rough=0.84, grain="karst", scale=1.0, bump_str=0.65)
    bm = bmesh.new()
    rings_z = 34
    cols = 40
    grid = []
    for iz in range(rings_z + 1):
        t = iz / rings_z
        z = t * 22.0
        # Classic Ha Long undercut wave notch near z=0.8m, swelling mid-shoulder, craggy twin-ridge summit!
        notch = -0.95 * math.exp(-(((z - 0.85) / 0.85) ** 2))
        profile = 5.6 * ((1.0 - t**1.45) ** 0.58) + notch + 0.55 * math.sin(t * math.pi * 2.6)
        lean_x = 1.45 * math.sin(t * math.pi * 0.85)
        lean_y = -0.65 * (t**1.4)
        ring = []
        for ic in range(cols):
            a = (ic / cols) * math.tau
            flute = (
                1.0
                + 0.22 * math.sin(a * 5.0 + t * 2.2)
                + 0.14 * math.cos(a * 9.0 - t * 3.8)
                + 0.06 * math.sin(a * 15.0 + t * 9.0)
            )
            r = max(0.32, profile * flute)
            x = lean_x + math.cos(a) * r * 1.08
            y = lean_y + math.sin(a) * r * 0.88
            ring.append(bm.verts.new((x, y, z)))
        grid.append(ring)

    for iz in range(rings_z):
        for ic in range(cols):
            ic_n = (ic + 1) % cols
            f = bm.faces.new((grid[iz][ic], grid[iz][ic_n], grid[iz + 1][ic_n], grid[iz + 1][ic]))
            f.smooth = True

    # Cap summit & base
    top_ctr = bm.verts.new((1.15, -0.65, 22.15))
    bot_ctr = bm.verts.new((0.0, 0.0, 0.0))
    for ic in range(cols):
        ic_n = (ic + 1) % cols
        ft = bm.faces.new((grid[rings_z][ic], grid[rings_z][ic_n], top_ctr))
        fb = bm.faces.new((grid[0][ic_n], grid[0][ic], bot_ctr))
        ft.smooth = True
        fb.smooth = False

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("KarstSpireTall")
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("KarstSpireTall", me)
    bpy.context.collection.objects.link(ob)
    ob.data.materials.append(m_karst)

    ground_all_meshes_to_z0()
    bake_objects_to_single_pbr_atlas([ob], "KarstSpireTall", res=1024, ao_samples=24, nor_samples=14)
    export_raw_glb(out_dir / "karst-spire-tall.glb")


def build_karst_arch_cove(out_dir: Path):
    """Natural boat-passable Ha Long limestone sea arch (22m span, clear 10.8m wide x 8.0m high passage!)."""
    m_karst = make_proc_mat("ArchKarst", "#aba496", "#555046", rough=0.84, grain="karst", scale=1.0, bump_str=0.65)
    parts = []

    def add_crag_pillar(name, x_sign):
        bm = bmesh.new()
        nz, nc = 24, 28
        grid = []
        for iz in range(nz + 1):
            t = iz / nz
            z = t * (15.4 if x_sign < 0 else 13.8)
            notch = -0.65 * math.exp(-(((z - 0.8) / 0.8) ** 2))
            rad_base = (3.45 if x_sign < 0 else 3.25) * ((1.0 - 0.62 * (t**1.5)) ** 0.7) + notch
            cx = x_sign * (8.4 - 1.35 * (t**1.3))
            cy = 0.45 * math.sin(t * 3.0 * x_sign)
            ring = []
            for ic in range(nc):
                a = (ic / nc) * math.tau
                fl = 1.0 + 0.18 * math.sin(a * 5.0 + x_sign) + 0.11 * math.cos(a * 8.0 - t * 4.0)
                ring.append(bm.verts.new((cx + math.cos(a) * rad_base * fl, cy + math.sin(a) * rad_base * 0.92 * fl, z)))
            grid.append(ring)
        for iz in range(nz):
            for ic in range(nc):
                icn = (ic + 1) % nc
                f = bm.faces.new((grid[iz][ic], grid[iz][icn], grid[iz + 1][icn], grid[iz + 1][ic]))
                f.smooth = True
        tc_v = bm.verts.new((x_sign * 7.0, 0.0, 15.6 if x_sign < 0 else 14.0))
        bc_v = bm.verts.new((x_sign * 8.4, 0.0, 0.0))
        for ic in range(nc):
            icn = (ic + 1) % nc
            bm.faces.new((grid[nz][ic], grid[nz][icn], tc_v)).smooth = True
            bm.faces.new((grid[0][icn], grid[0][ic], bc_v))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new(name)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(ob)
        ob.data.materials.append(m_karst)
        return ob

    parts.append(add_crag_pillar("ArchPillar_W", -1.0))
    parts.append(add_crag_pillar("ArchPillar_E", 1.0))

    # Vaulted limestone bridge span arching from x = -7.6 to +7.6 with soffit clear height = 8.2m at x = 0!
    bm = bmesh.new()
    nu, nc = 26, 24
    grid = []
    for iu in range(nu + 1):
        u = iu / nu
        x = -7.8 + u * 15.6
        arch = math.sin(u * math.pi)
        z_center = 6.8 + 3.9 * arch
        rx_thick = 2.45 - 0.55 * arch
        ry_thick = 2.85 - 0.45 * arch
        ring = []
        for ic in range(nc):
            a = (ic / nc) * math.tau
            crag = 1.0 + 0.15 * math.sin(a * 6.0 + u * 9.0) + 0.09 * math.cos(a * 10.0 - u * 5.0)
            # Keep soffit bottom (-Z) cleanly arched >= 8.0m at center
            dz = math.sin(a) * rx_thick * crag
            dy = math.cos(a) * ry_thick * crag
            ring.append(bm.verts.new((x, dy, z_center + dz)))
        grid.append(ring)
    for iu in range(nu):
        for ic in range(nc):
            icn = (ic + 1) % nc
            f = bm.faces.new((grid[iu][ic], grid[iu + 1][ic], grid[iu + 1][icn], grid[iu][icn]))
            f.smooth = True
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me_s = bpy.data.meshes.new("ArchVaultSpan")
    bm.to_mesh(me_s)
    bm.free()
    span_ob = bpy.data.objects.new("ArchVaultSpan", me_s)
    bpy.context.collection.objects.link(span_ob)
    span_ob.data.materials.append(m_karst)
    parts.append(span_ob)

    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = "KarstArchCove"
    ground_all_meshes_to_z0()
    bake_objects_to_single_pbr_atlas([merged], "KarstArchCove", res=1024, ao_samples=24, nor_samples=14)
    export_raw_glb(out_dir / "karst-arch-cove.glb")


def build_rock_coastal_cluster(out_dir: Path):
    """3 eroded coastal boulders composed from Poly Haven CC0 `boulder_01` and `rock_07`."""
    b1_path = FACTORY_NATURE / "ph_rock_park_boulder_large.glb"
    r7_path = POLYHAVEN_MODELS / "rock_07" / "rock_07_1k.gltf"

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(b1_path))
    b1_objs = [o for o in bpy.context.scene.objects if o not in before and o.type == "MESH"]
    for o in b1_objs:
        o.scale = (1.65, 1.55, 1.35)
        o.location = (-0.45, 0.15, 0.0)
        bpy.context.view_layer.objects.active = o
        mod = o.modifiers.new("Dec", "DECIMATE")
        mod.ratio = 0.14
        bpy.ops.object.modifier_apply(modifier=mod.name)

    before2 = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(r7_path))
    r7_objs = [o for o in bpy.context.scene.objects if o not in before2 and o.type == "MESH"]
    for o in r7_objs:
        bpy.context.view_layer.objects.active = o
        mod = o.modifiers.new("Dec", "DECIMATE")
        mod.ratio = 0.18
        bpy.ops.object.modifier_apply(modifier=mod.name)
        o.location = (1.45, -0.35, 0.0)
        o.scale = (4.4, 4.2, 3.6)
        o.rotation_euler = (0.08, -0.12, 1.15)

        # Third nested coastal boulder
        dup = o.copy()
        dup.data = o.data.copy()
        dup.location = (-1.45, -0.75, -0.05)
        dup.scale = (3.4, 3.6, 2.8)
        dup.rotation_euler = (-0.1, 0.14, 3.6)
        bpy.context.collection.objects.link(dup)

    ground_all_meshes_to_z0()
    export_raw_glb(out_dir / "rock-coastal-cluster.glb")


def build_pavilion_tropical_speaking(out_dir: Path):
    """Open-air octagonal Cedar Timber & Woven Thatch Tropical Speaking Pavilion with carved stone plinth & warm lanterns."""
    m_stone = make_proc_mat("PavStone", "#dfd5c2", "#aba08d", rough=0.72, grain="stone", scale=3.2, bump_str=0.35)
    m_cedar = make_proc_mat("PavCedar", "#8d5632", "#59341c", rough=0.52, grain="wood", scale=5.5, bump_str=0.32)
    m_thatch = make_proc_mat("PavThatch", "#b58c44", "#735424", rough=0.88, grain="thatch", scale=3.8, bump_str=0.58)
    m_brass = make_proc_mat("PavBrass", "#d49b42", "#558276", rough=0.30, metal=0.85, grain="bronze_patina", scale=5.0, bump_str=0.18)
    m_glow = make_proc_mat("PavGlow", "#ffe29a", "#ffc35c", rough=0.22, grain="stone", scale=4.0, bump_str=0.0, em_hex="#ffbe58", em_str=2.6)

    objs = []
    # 2-step octagonal carved coral-travertine stone plinth (walkable floor z = 0.24m)
    objs.append(add_cyl("PlinthStep1", (0, 0, 0.06), 3.95, 0.12, m_stone, verts=8, r_top=3.88, bevel_w=0.02))
    objs.append(add_cyl("PlinthStep2", (0, 0, 0.18), 3.62, 0.12, m_stone, verts=8, r_top=3.56, bevel_w=0.02))
    objs.append(add_cyl("CenterMedallion", (0, 0, 0.248), 1.35, 0.018, m_brass, verts=24, bevel_w=0.004))

    # 8 turned cedar columns + bronze base shoes + knee braces + perimeter ring beams + 4 low speaking benches
    col_r = 3.08
    for i in range(8):
        a = i * math.tau / 8.0 + math.pi / 8.0
        cx, cy = math.cos(a) * col_r, math.sin(a) * col_r
        objs.append(add_cyl(f"ColShoe_{i}", (cx, cy, 0.31), 0.165, 0.14, m_brass, verts=12))
        objs.append(add_cyl(f"CedarCol_{i}", (cx, cy, 1.76), 0.135, 2.82, m_cedar, verts=14, r_top=0.115))
        a_next = ((i + 1) % 8) * math.tau / 8.0 + math.pi / 8.0
        nx, ny = math.cos(a_next) * col_r, math.sin(a_next) * col_r
        mx, my = (cx + nx) * 0.5, (cy + ny) * 0.5
        span = math.hypot(nx - cx, ny - cy)
        beam_ang = math.atan2(ny - cy, nx - cx)
        objs.append(add_box(f"RingBeam_{i}", (mx, my, 3.16), (span + 0.16, 0.18, 0.22), m_cedar, rot=(0, 0, beam_ang)))
        # Diagonal wind braces
        for sgn, bx0, by0 in ((1, cx, cy), (-1, nx, ny)):
            objs.append(
                add_tube(
                    f"Brace_{i}_{sgn}",
                    [(bx0, by0, 2.52), (bx0 * 0.84 + mx * 0.16, by0 * 0.84 + my * 0.16, 2.86), (bx0 * 0.65 + mx * 0.35, by0 * 0.65 + my * 0.35, 3.14)],
                    0.048,
                    m_cedar,
                    res_u=4,
                )
            )
        # Built-in cedar speaking benches on alternate bays (leaving 4 wide entry aisles!)
        if i % 2 == 1:
            objs.append(add_box(f"PavBench_{i}", (mx * 0.96, my * 0.96, 0.64), (span * 0.78, 0.42, 0.065), m_cedar, rot=(0, 0, beam_ang)))
            for leg_t in (-0.3, 0.3):
                lx = mx * 0.96 + math.cos(beam_ang) * span * leg_t
                ly = my * 0.96 + math.sin(beam_ang) * span * leg_t
                objs.append(add_box(f"BenchLeg_{i}_{leg_t}", (lx, ly, 0.43), (0.10, 0.36, 0.38), m_stone, rot=(0, 0, beam_ang)))

        # Warm wrought-brass lantern hooks + glowing amber lanterns at eaves (4 cardinal corners)
        if i % 2 == 0:
            hx, hy = math.cos(a) * 3.55, math.sin(a) * 3.55
            objs.append(
                add_tube(
                    f"LanternHook_{i}",
                    [(cx, cy, 3.05), (hx * 0.96, hy * 0.96, 3.12), (hx, hy, 2.96)],
                    0.018,
                    m_brass,
                    res_u=5,
                )
            )
            objs.append(add_cyl(f"LanternCap_{i}", (hx, hy, 2.90), 0.13, 0.06, m_brass, verts=8, r_top=0.03))
            objs.append(add_cyl(f"LanternCore_{i}", (hx, hy, 2.77), 0.095, 0.20, m_glow, verts=8, bevel_w=0))
            objs.append(add_cyl(f"LanternBot_{i}", (hx, hy, 2.65), 0.085, 0.04, m_brass, verts=8))

    # Double-tiered octagonal woven palm-thatch roof + ventilated clerestory + carved brass finial
    objs.append(add_cyl("ThatchLowerTier", (0, 0, 3.68), 4.25, 1.05, m_thatch, verts=8, r_top=1.95, bevel_w=0.04))
    objs.append(add_cyl("ClerestoryCollar", (0, 0, 4.22), 1.82, 0.28, m_cedar, verts=8, r_top=1.78, bevel_w=0.015))
    objs.append(add_cyl("ThatchUpperCrown", (0, 0, 4.76), 2.18, 0.92, m_thatch, verts=8, r_top=0.18, bevel_w=0.03))
    objs.append(add_cyl("RoofFinial", (0, 0, 5.38), 0.12, 0.42, m_brass, verts=12, r_top=0.015))

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    merged = bpy.context.view_layer.objects.active
    merged.name = "PavilionTropicalSpeaking"
    ground_all_meshes_to_z0()
    bake_objects_to_single_pbr_atlas([merged], "PavilionSpeaking", res=1024, ao_samples=22, nor_samples=12)
    export_raw_glb(out_dir / "pavilion-tropical-speaking.glb")


def build_village_stilt_house(shared, out_dir: Path):
    """Coastal fishing village wooden stilt cottage with bamboo veranda, coiled rope & drying fishing net."""
    m_pile = make_proc_mat("IronwoodPile", "#4a3525", "#2d1f15", rough=0.78, grain="wood", scale=6.0, bump_str=0.40)
    m_wall = make_proc_mat("CedarWall", "#9c6b43", "#6e4829", rough=0.62, grain="wood", scale=7.0, bump_str=0.34)
    m_bamboo = make_proc_mat("BambooTrim", "#c8a15a", "#8f6d34", rough=0.56, grain="bamboo", scale=8.0, bump_str=0.36)
    m_thatch = make_proc_mat("CottageThatch", "#ad833e", "#6d4e1f", rough=0.88, grain="thatch", scale=4.2, bump_str=0.56)
    m_rope = make_proc_mat("HempRope", "#cfb582", "#967e52", rough=0.86, grain="thatch", scale=12.0, bump_str=0.35)
    m_glow = make_proc_mat("PorchGlow", "#ffd88a", "#ffb84d", rough=0.25, grain="stone", em_hex="#ffbe55", em_str=2.4)

    objs = []
    # 9 heavy ironwood stilt pilings + cross-bracing raising deck to z = 1.35m
    for ix, x in enumerate((-2.3, 0.0, 2.3)):
        for iy, y in enumerate((-2.0, 0.2, 2.0)):
            objs.append(add_cyl(f"Stilt_{ix}_{iy}", (x, y, 0.72), 0.13, 1.44, m_pile, verts=12))
    for x in (-2.3, 2.3):
        objs.append(add_box(f"BearerX_{x}", (x, 0.0, 1.32), (0.18, 4.4, 0.18), m_pile))
    for y in (-2.0, 0.2, 2.0):
        objs.append(add_box(f"JoistY_{y}", (0.0, y, 1.38), (5.0, 0.16, 0.16), m_pile))

    # Slatted timber deck + front shaded veranda (front = -Y -> Three.js +Z!)
    objs.append(add_box("MainDeck", (0.0, 0.0, 1.48), (5.2, 4.5, 0.09), m_wall, bevel_w=0.015))

    # Sloped entry bamboo/timber stair at front (-Y)
    for st in range(6):
        t = st / 5.0
        objs.append(add_box(f"Step_{st}", (-0.85, -2.35 - (1.0 - t) * 1.15, 0.18 + t * 1.24), (1.15, 0.28, 0.065), m_wall))
    for sx in (-1.42, -0.28):
        objs.append(add_tube(f"StairStringer_{sx}", [(sx, -3.58, 0.08), (sx, -2.28, 1.48)], 0.045, m_pile, res_u=4))

    # Cabin walls (y = -0.65 .. +2.05) leaving a 1.55m deep front veranda!
    objs.append(add_box("CabinBody", (0.0, 0.68, 2.66), (4.5, 2.75, 2.28), m_wall, bevel_w=0.02))
    objs.append(add_box("BambooWainscot", (0.0, 0.68, 1.92), (4.56, 2.81, 0.76), m_bamboo, bevel_w=0.015))
    # Door + louvered shutters
    objs.append(add_box("FrontDoor", (-0.85, -0.71, 2.42), (0.92, 0.08, 1.78), m_pile, bevel_w=0.01))
    objs.append(add_box("FrontWindow", (1.05, -0.71, 2.68), (1.18, 0.09, 0.96), m_bamboo, bevel_w=0.01))
    for side in (-1, 1):
        objs.append(add_box(f"SideShutter_{side}", (side * 2.28, 0.68, 2.68), (0.09, 1.12, 0.96), m_bamboo))

    # Veranda corner posts + bamboo balustrade rail + coiled rope + porch lantern
    for vx in (-2.35, 0.15, 2.35):
        objs.append(add_cyl(f"VerandaPost_{vx}", (vx, -2.05, 2.58), 0.085, 2.18, m_pile, verts=10))
    objs.append(add_box("VerandaRailR", (1.25, -2.05, 2.22), (2.25, 0.08, 0.08), m_bamboo))
    for side in (-1, 1):
        objs.append(add_box(f"VerandaSideRail_{side}", (side * 2.35, -1.35, 2.22), (0.08, 1.45, 0.08), m_bamboo))

    # Coiled mooring rope on veranda deck
    for turn in range(3):
        rr = 0.11 + turn * 0.032
        pts = [(1.65 + rr * math.cos(a), -1.45 + rr * math.sin(a), 1.55) for a in [k * math.tau / 16 for k in range(16)]]
        objs.append(add_tube(f"DeckRope_{turn}", pts, 0.016, m_rope, res_u=4, cyclic=True))

    # Hanging warm porch lantern
    objs.append(add_cyl("PorchLanternTop", (0.15, -2.18, 3.35), 0.12, 0.06, m_bamboo, verts=10, r_top=0.03))
    objs.append(add_cyl("PorchLanternGlow", (0.15, -2.18, 3.22), 0.09, 0.18, m_glow, verts=10, bevel_w=0))

    # Pitched tropical gable/hipped palm-thatch roof with wide tropical eaves
    bm = bmesh.new()
    v_eave = [
        bm.verts.new((-2.85, -2.55, 3.58)),
        bm.verts.new((2.85, -2.55, 3.58)),
        bm.verts.new((2.85, 2.55, 3.58)),
        bm.verts.new((-2.85, 2.55, 3.58)),
    ]
    v_ridge = [bm.verts.new((-1.45, 0.0, 5.15)), bm.verts.new((1.45, 0.0, 5.15))]
    bm.faces.new((v_eave[0], v_eave[1], v_ridge[1], v_ridge[0]))
    bm.faces.new((v_eave[2], v_eave[3], v_ridge[0], v_ridge[1]))
    bm.faces.new((v_eave[1], v_eave[2], v_ridge[1]))
    bm.faces.new((v_eave[3], v_eave[0], v_ridge[0]))
    bm.faces.new((v_eave[3], v_eave[2], v_eave[1], v_eave[0]))
    bmesh.ops.solidify(bm, geom=bm.faces[:] + bm.edges[:] + bm.verts[:], thickness=0.16)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me_r = bpy.data.meshes.new("StiltThatchRoof")
    bm.to_mesh(me_r)
    bm.free()
    roof_ob = bpy.data.objects.new("StiltThatchRoof", me_r)
    bpy.context.collection.objects.link(roof_ob)
    roof_ob.data.materials.append(m_thatch)
    for p in roof_ob.data.polygons:
        p.use_smooth = True
    objs.append(roof_ob)

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    house_ob = bpy.context.view_layer.objects.active
    house_ob.name = "VillageStiltHouse"
    ground_all_meshes_to_z0()
    bake_objects_to_single_pbr_atlas([house_ob], "VillageStiltHouse", res=1024, ao_samples=22, nor_samples=12)

    # Draped drying fishing net along front-right veranda rail (MASK, double-sided!)
    bm_n = bmesh.new()
    uv_n = bm_n.loops.layers.uv.new("UVMap")
    nx_steps, nz_steps = 10, 6
    ngrid = []
    for ix in range(nx_steps + 1):
        u = ix / nx_steps
        x = 0.22 + u * 2.05
        sag = 0.26 * math.sin(u * math.pi)
        col_v = []
        for iz in range(nz_steps + 1):
            v = iz / nz_steps
            z = 2.20 - v * (1.05 + sag)
            y = -2.09 - 0.08 * math.sin(v * math.pi) * math.sin(u * math.pi * 2.0)
            col_v.append((bm_n.verts.new((x, y, z)), u * 2.2, v * 1.4))
        ngrid.append(col_v)
    for ix in range(nx_steps):
        for iz in range(nz_steps):
            v00, u00, w00 = ngrid[ix][iz]
            v10, u10, w10 = ngrid[ix + 1][iz]
            v11, u11, w11 = ngrid[ix + 1][iz + 1]
            v01, u01, w01 = ngrid[ix][iz + 1]
            f = bm_n.faces.new((v00, v10, v11, v01))
            f.smooth = True
            for lp, uv_c in zip(f.loops, ((u00, w00), (u10, w10), (u11, w11), (u01, w01))):
                lp[uv_n].uv = uv_c
    me_n = bpy.data.meshes.new("DryingFishingNet")
    bm_n.to_mesh(me_n)
    bm_n.free()
    net_ob = bpy.data.objects.new("DryingFishingNet", me_n)
    bpy.context.collection.objects.link(net_ob)
    net_ob.data.materials.append(shared["fishing_net_mat"])

    export_raw_glb(out_dir / "village-stilt-house.glb")


def build_village_market_stall(shared, out_dir: Path):
    """Coastal bamboo canopy fruit & fish market stall with rattan baskets, produce, coiled rope & drying net."""
    m_bamboo = make_proc_mat("StallBamboo", "#cca45a", "#8c6930", rough=0.52, grain="bamboo", scale=8.0, bump_str=0.35)
    m_wood = make_proc_mat("StallWood", "#8d5b36", "#5c381e", rough=0.62, grain="wood", scale=6.0, bump_str=0.32)
    m_thatch = make_proc_mat("StallCanopy", "#ba9045", "#785822", rough=0.85, grain="thatch", scale=5.0, bump_str=0.50)
    m_mango = make_proc_mat("StallMango", "#f29622", "#d83b28", rough=0.34, grain="stone", scale=6.0, bump_str=0.08)
    m_coco = make_proc_mat("StallCoco", "#587d2e", "#3c591d", rough=0.45, grain="wood", scale=6.0, bump_str=0.14)
    m_fish = make_proc_mat("StallFish", "#7fa2b5", "#3b596b", rough=0.26, metal=0.35, grain="stone", scale=9.0, bump_str=0.15)
    m_rope = make_proc_mat("StallRope", "#d1b884", "#988052", rough=0.85, grain="thatch", scale=12.0, bump_str=0.35)
    m_glow = make_proc_mat("StallGlow", "#ffdc92", "#ffbe52", rough=0.22, grain="stone", em_hex="#ffbe52", em_str=2.4)

    objs = []
    # 4 corner bamboo poles + pitched woven mat canopy
    for x in (-1.55, 1.55):
        for y, h in ((-0.95, 2.48), (0.95, 2.15)):
            objs.append(add_cyl(f"Pole_{x}_{y}", (x, y, h * 0.5), 0.055, h, m_bamboo, verts=12))
    objs.append(add_box("CounterTop", (0, -0.15, 0.88), (3.18, 1.15, 0.065), m_wood, bevel_w=0.012))
    objs.append(add_box("CounterFront", (0, -0.68, 0.45), (3.08, 0.06, 0.82), m_bamboo, bevel_w=0.01))
    objs.append(add_box("LowerShelf", (0, -0.15, 0.28), (2.95, 0.96, 0.05), m_wood))

    # Sloped canopy frame + woven palm-mat roof
    objs.append(add_box("CanopyMat", (0, 0.0, 2.42), (3.55, 2.45, 0.09), m_thatch, rot=(math.radians(9.5), 0, 0), bevel_w=0.02))
    for x in (-1.55, 0.0, 1.55):
        objs.append(add_box(f"Rafter_{x}", (x, 0.0, 2.35), (0.07, 2.42, 0.08), m_bamboo, rot=(math.radians(9.5), 0, 0)))

    # 3 woven rattan display baskets heaped with mangoes, green coconuts, and silver coastal fish!
    for idx, (bx, item_mat, item_scale) in enumerate(
        ((-0.95, m_mango, (0.08, 0.065, 0.095)), (0.0, m_coco, (0.105, 0.105, 0.12)), (0.95, m_fish, (0.16, 0.055, 0.038)))
    ):
        objs.append(add_cyl(f"Basket_{idx}", (bx, -0.15, 0.97), 0.36, 0.12, m_bamboo, verts=16, r_top=0.42))
        for k in range(6):
            ka = k * math.tau / 6.0
            kr = 0.16 if k < 5 else 0.0
            kz = 1.03 if k < 5 else 1.10
            objs.append(
                add_sphere(
                    f"Goods_{idx}_{k}",
                    (bx + math.cos(ka) * kr, -0.15 + math.sin(ka) * kr, kz),
                    item_scale,
                    item_mat,
                    segs=10,
                    rings=8,
                    rot=(0, 0, ka),
                )
            )

    # Coiled rope on lower shelf + warm hanging bamboo lantern
    for t in range(3):
        rr = 0.10 + t * 0.03
        pts = [(-1.05 + rr * math.cos(a), -0.15 + rr * math.sin(a), 0.33) for a in [k * math.tau / 14 for k in range(14)]]
        objs.append(add_tube(f"StallRope_{t}", pts, 0.015, m_rope, res_u=4, cyclic=True))
    objs.append(add_cyl("StallLanternCap", (1.35, -0.95, 2.22), 0.10, 0.05, m_bamboo, verts=8, r_top=0.02))
    objs.append(add_cyl("StallLanternGlow", (1.35, -0.95, 2.11), 0.075, 0.16, m_glow, verts=8, bevel_w=0))

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    stall_ob = bpy.context.view_layer.objects.active
    stall_ob.name = "VillageMarketStall"
    ground_all_meshes_to_z0()
    bake_objects_to_single_pbr_atlas([stall_ob], "VillageMarketStall", res=1024, ao_samples=20, nor_samples=12)

    # Draped decorative fishing net across side bamboo pole
    bm_n = bmesh.new()
    uv_n = bm_n.loops.layers.uv.new("UVMap")
    v0 = bm_n.verts.new((-1.58, -0.92, 2.25))
    v1 = bm_n.verts.new((-1.58, 0.92, 2.02))
    v2 = bm_n.verts.new((-1.64, 0.78, 0.92))
    v3 = bm_n.verts.new((-1.64, -0.78, 1.05))
    f = bm_n.faces.new((v0, v1, v2, v3))
    for lp, uv_c in zip(f.loops, ((0, 0), (1.8, 0), (1.8, 1.4), (0, 1.4))):
        lp[uv_n].uv = uv_c
    me_n = bpy.data.meshes.new("StallNet")
    bm_n.to_mesh(me_n)
    bm_n.free()
    net_ob = bpy.data.objects.new("StallNet", me_n)
    bpy.context.collection.objects.link(net_ob)
    net_ob.data.materials.append(shared["fishing_net_mat"])

    export_raw_glb(out_dir / "village-market-stall.glb")


def build_harbor_whale_monument(out_dir: Path):
    """
    Refined Bronze & Travertine Echo Whale Sanctuary Sculpture (< 6,500 tris LOD0 / ~1,600 tris LOD1,
    1 draw call, baked 1024px Aged Bronze + Verdigris Patina Normal + ORM!).
    """
    m_bronze = make_proc_mat("WhaleBronze", "#c99246", "#3b8577", rough=0.32, metal=0.86, grain="bronze_patina", scale=3.5, bump_str=0.24)
    m_wave = make_proc_mat("WaveBronze", "#2e787e", "#76b2ad", rough=0.38, metal=0.45, grain="bronze_patina", scale=4.0, bump_str=0.20)
    m_stone = make_proc_mat("MonumentTravertine", "#e3dac8", "#afa490", rough=0.68, grain="stone", scale=3.8, bump_str=0.32)

    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=str(WHALE_SOURCE_GLB))
    new_objs = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new_objs if o.type == "ARMATURE")
    body = next(o for o in new_objs if o.type == "MESH" and len(o.data.vertices) > 200)
    if arm.animation_data:
        arm.animation_data.action = None

    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    for pb in arm.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0, 0, 0)
    for bname, deg in (("Bone.001_02", 5), ("Bone.002_03", 9), ("Bone.003_04", 12), ("Bone.004_05", 11), ("Bone.005_06", 8), ("Bone.006_07", 6)):
        if bname in arm.pose.bones:
            arm.pose.bones[bname].rotation_euler = (math.radians(deg), 0, 0)
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
    for o in new_objs:
        if o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)

    whale.data.transform(Matrix.Rotation(math.pi, 4, "X"))
    whale.data.transform(Matrix.Rotation(math.radians(-30), 4, "X"))
    bb = [Vector(v.co) for v in whale.data.vertices]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    k = 3.05 / max(0.01, hi.z - lo.z)
    whale.data.transform(Matrix.Scale(k, 4))
    lo, hi = lo * k, hi * k
    whale.data.transform(Matrix.Translation(Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2 + 0.15, 0.72 - lo.z))))

    # Smooth silhouette at Subdiv 1, then decimate cleanly so total monument stays < 6,200 tris (< 7,500 budget!)
    bpy.context.view_layer.objects.active = whale
    sub = whale.modifiers.new("Smooth", "SUBSURF")
    sub.levels = 1
    sub.render_levels = 1
    bpy.ops.object.modifier_apply(modifier=sub.name)
    if len(whale.data.polygons) > 3600:
        dec = whale.modifiers.new("Dec", "DECIMATE")
        dec.ratio = 3500.0 / len(whale.data.polygons)
        bpy.ops.object.modifier_apply(modifier=dec.name)
    for poly in whale.data.polygons:
        poly.use_smooth = True
    whale.data.materials.clear()
    whale.data.materials.append(m_bronze)

    parts = [whale]
    # Stepped carved travertine plinth + bronze dedication band + curling wave crests
    parts.append(add_cyl("WhaleStep1", (0, 0, 0.11), 1.90, 0.22, m_stone, verts=32, r_top=1.84))
    parts.append(add_cyl("WhaleStep2", (0, 0, 0.32), 1.62, 0.20, m_stone, verts=32, r_top=1.56))
    parts.append(add_cyl("WhaleBand", (0, 0, 0.44), 1.585, 0.05, m_bronze, verts=36))
    parts.append(add_cyl("WhaleBasin", (0, 0, 0.56), 1.42, 0.22, m_stone, verts=32, r_top=1.38))

    for i, (r0, a0, h1, rad) in enumerate(((1.08, 0.0, 1.46, 0.28), (0.96, 2.1, 1.32, 0.22), (0.72, 4.1, 1.58, 0.18))):
        pts = []
        for j in range(9):
            t = j / 8.0
            a = a0 + t * 2.5
            r = r0 * (1.0 - 0.60 * t) + 0.06
            pts.append((math.cos(a) * r, math.sin(a) * r, 0.62 + (h1 - 0.62) * math.sin(t * math.pi * 0.6) - 0.22 * t * t))
        parts.append(add_tube(f"WhaleWave_{i}", pts, rad, m_wave, res_u=8, bevel_res=2, taper_end=0.14))

    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    monument = bpy.context.view_layer.objects.active
    monument.name = "HarborWhaleMonument"
    ground_all_meshes_to_z0()
    bake_objects_to_single_pbr_atlas([monument], "HarborWhaleMonument", res=1024, ao_samples=24, nor_samples=14)
    export_raw_glb(out_dir / "harbor-whale-monument.glb")


def build_harbor_lighthouse(out_dir: Path):
    """Painted stone coastal lighthouse (14.5m tall) with coral daymark bands, brass gallery rail & Fresnel lantern dome."""
    m_base = make_proc_mat("LightGranite", "#8b8780", "#5b5752", rough=0.78, grain="stone", scale=4.0, bump_str=0.45)
    m_white = make_proc_mat("LightStucco", "#f0ece1", "#c7c0b0", rough=0.62, grain="stone", scale=5.0, bump_str=0.28)
    m_coral = make_proc_mat("LightDaymark", "#c94838", "#8f2c20", rough=0.56, grain="stone", scale=5.0, bump_str=0.26)
    m_brass = make_proc_mat("LightBrass", "#d49d44", "#3d8275", rough=0.28, metal=0.88, grain="bronze_patina", scale=5.0, bump_str=0.16)
    m_wood = make_proc_mat("LightDoor", "#6e4427", "#422714", rough=0.58, grain="wood", scale=6.0, bump_str=0.30)
    m_beacon = make_proc_mat("BeaconLamp", "#fff2b2", "#ffd269", rough=0.15, grain="stone", em_hex="#ffd875", em_str=3.2)

    objs = []
    # Octagonal granite foundation + keeper entry door
    objs.append(add_cyl("FoundationOct", (0, 0, 1.15), 2.65, 2.30, m_base, verts=8, r_top=2.28, bevel_w=0.03))
    objs.append(add_box("EntryPorch", (0, -2.25, 1.12), (1.35, 0.65, 2.15), m_base, bevel_w=0.02))
    objs.append(add_box("KeeperDoor", (0, -2.59, 0.98), (0.86, 0.08, 1.76), m_wood, bevel_w=0.01))

    # Tapered painted masonry shaft in alternating white & coastal-coral daymark bands
    bands = [
        (2.30, 4.80, 2.18, 1.94, m_white),
        (4.80, 7.20, 1.94, 1.72, m_coral),
        (7.20, 9.60, 1.72, 1.52, m_white),
        (9.60, 11.20, 1.52, 1.38, m_coral),
    ]
    for idx, (z0, z1, rb, rt, mat_b) in enumerate(bands):
        objs.append(add_cyl(f"TowerBand_{idx}", (0, 0, (z0 + z1) * 0.5), rb, z1 - z0, mat_b, verts=24, r_top=rt, bevel_w=0.01))
        if idx < 3:
            wz = (z0 + z1) * 0.5
            wr = (rb + rt) * 0.5
            objs.append(add_box(f"ShaftWindow_{idx}", (0, -wr + 0.02, wz), (0.38, 0.14, 0.68), m_wood))

    # Corbeled stone gallery deck + brass gallery safety railing
    objs.append(add_cyl("GalleryCorbel", (0, 0, 11.42), 1.38, 0.44, m_base, verts=24, r_top=1.92, bevel_w=0.02))
    objs.append(add_cyl("GalleryDeck", (0, 0, 11.72), 1.98, 0.16, m_base, verts=24, bevel_w=0.02))
    for k in range(16):
        a = k * math.tau / 16.0
        objs.append(add_cyl(f"RailPost_{k}", (math.cos(a) * 1.86, math.sin(a) * 1.86, 12.28), 0.028, 0.96, m_brass, verts=8))
    for rz in (12.28, 12.74):
        pts = [(1.86 * math.cos(k * math.tau / 24), 1.86 * math.sin(k * math.tau / 24), rz) for k in range(24)]
        objs.append(add_tube(f"GalleryRail_{rz}", pts, 0.026, m_brass, res_u=4, cyclic=True))

    # Lantern room mullions, glowing Fresnel beacon core & verdigris brass cupola dome + weathervane
    objs.append(add_cyl("LanternBaseWall", (0, 0, 12.08), 1.26, 0.56, m_brass, verts=16))
    objs.append(add_cyl("FresnelBeaconCore", (0, 0, 12.88), 0.52, 0.88, m_beacon, verts=16, bevel_w=0))
    for k in range(8):
        a = k * math.tau / 8.0
        objs.append(add_cyl(f"Mullion_{k}", (math.cos(a) * 1.18, math.sin(a) * 1.18, 12.92), 0.032, 1.16, m_brass, verts=8))
    objs.append(add_sphere("CupolaDome", (0, 0, 13.52), (1.28, 1.28, 0.78), m_brass, segs=20, rings=10))
    objs.append(add_cyl("LightningSpire", (0, 0, 14.42), 0.045, 0.68, m_brass, verts=8, r_top=0.01))

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    tower_ob = bpy.context.view_layer.objects.active
    tower_ob.name = "HarborLighthouseSolid"
    ground_all_meshes_to_z0()
    bake_objects_to_single_pbr_atlas([tower_ob], "HarborLighthouse", res=1024, ao_samples=22, nor_samples=12)

    # Zero-transmission Fresnel lantern glazing cylinder
    m_glass = make_fresnel_glass_mat("LighthouseLanternGlass", "#bce6f2", alpha=0.28)
    glass = add_cyl("LanternGlazing", (0, 0, 12.92), 1.16, 1.12, m_glass, verts=16, bevel_w=0)
    glass.location.z = tower_ob.location.z + 12.92

    export_raw_glb(out_dir / "harbor-lighthouse.glb")


# ==============================================================================
# 7. CATEGORY 3 — 7 DISTINCT DETAILED MARITIME VESSELS (EXACT NODE CONTRACTS)
# ==============================================================================
def add_articulated_oars(m_cedar, m_teak, m_cream, m_brass):
    """Creates exact `Oar_L` (+0.68, -0.24, 0.53) and `Oar_R` (-0.68, -0.24, 0.53) Empty pivots + 1 merged child mesh each."""
    oar_meshes = []
    for label, side in (("Oar_L", 1), ("Oar_R", -1)):
        oar_empty = make_empty(label, loc=(side * 0.68, -0.24, 0.53))
        ux, uz = side * math.cos(math.radians(15.0)), -math.sin(math.radians(15.0))
        add_cyl(
            f"{label}_Collar",
            (0, 0, 0),
            0.028,
            0.11,
            m_brass,
            verts=14,
            rot=(0, math.radians(90 * side - 15 * side), 0),
            parent=oar_empty,
        )
        add_tube(
            f"{label}_Shaft",
            [(-ux * 0.46, 0, -uz * 0.46), (0, 0, 0), (ux * 0.55, 0, uz * 0.55), (ux * 1.04, 0, uz * 1.04)],
            0.021,
            m_cedar,
            res_u=6,
            taper_end=0.82,
            parent=oar_empty,
        )
        add_tube(
            f"{label}_Grip",
            [(-ux * 0.34, 0, -uz * 0.34), (-ux * 0.42, 0, -uz * 0.42), (-ux * 0.49, 0, -uz * 0.49)],
            0.024,
            m_teak,
            res_u=4,
            taper_end=0.90,
            parent=oar_empty,
        )
        add_box(
            f"{label}_Blade",
            (ux * 1.30, 0, uz * 1.30),
            (0.56, 0.155, 0.018),
            m_cream,
            rot=(0, math.radians(15.0 * side), 0),
            bevel_w=0.007,
            parent=oar_empty,
        )
        oar_meshes.append(join_children_under_empty(oar_empty, f"{label}_Mesh"))
    return oar_meshes


def build_vessel_skiff(out_dir: Path):
    """
    Clinker-built cedar & cream rowboat preserving `Rowboat_Hull`, `Oar_L`, `Oar_R` Empty pivots,
    exact ROWER_SEAT/PASSENGER_SEAT heights, 3 primitives total (<= 4!), baked 1K Wood/Brass Normal+ORM!
    """
    m_teak = make_proc_mat("SkiffTeak", "#8e5a36", "#5c361d", rough=0.48, grain="wood", scale=6.5, bump_str=0.30)
    m_cedar = make_proc_mat("SkiffCedar", "#b98456", "#855934", rough=0.55, grain="wood", scale=7.0, bump_str=0.28)
    m_cream = make_proc_mat("SkiffCream", "#efe6d2", "#c8bea6", rough=0.38, grain="marine_enamel", scale=5.0, bump_str=0.10)
    m_teal = make_proc_mat("SkiffTeal", "#2d7c82", "#1c5257", rough=0.36, grain="marine_enamel", scale=5.0, bump_str=0.10)
    m_brass = make_proc_mat("SkiffBrass", "#d49c45", "#588072", rough=0.28, metal=0.86, grain="bronze_patina", scale=6.0, bump_str=0.14)
    m_rope = make_proc_mat("SkiffRope", "#cbb282", "#947e54", rough=0.84, grain="thatch", scale=12.0, bump_str=0.35)
    m_cush = make_proc_mat("SkiffCushion", "#386b7a", "#244954", rough=0.72, grain="fabric", scale=14.0, bump_str=0.18)
    m_glow = make_proc_mat("SkiffGlow", "#ffd584", "#ffbe55", rough=0.22, grain="stone", em_hex="#ffbe55", em_str=2.4)

    hull_root = make_empty("Rowboat_Hull", (0, 0, 0))
    stations, strakes = 24, 7

    def half_beam(u):
        if u < 0.52:
            return 0.72 * (math.sin((u / 0.52) * math.pi * 0.5) ** 0.72)
        return 0.72 * (1.0 - 0.39 * (((u - 0.52) / 0.48) ** 1.55))

    def sheer_z(u):
        return 0.45 + 0.20 * ((1.0 - min(1.0, u / 0.42)) ** 1.8) + 0.09 * (max(0.0, (u - 0.62) / 0.38) ** 1.6)

    def keel_z(u):
        return -0.21 + 0.16 * ((1.0 - min(1.0, u / 0.22)) ** 2.0) + 0.10 * (max(0.0, (u - 0.78) / 0.22) ** 1.8)

    bm = bmesh.new()
    outer_g, inner_g = [], []
    wt = 0.036
    for i in range(stations + 1):
        u = i / stations
        y = -2.02 + u * 3.84
        hb = max(0.018, half_beam(u))
        zt, zb = sheer_z(u), keel_z(u)
        pts_h = []
        for s in range(strakes + 1):
            v = s / strakes
            lap = 0.008 * ((s % 2) - 0.5) if 0 < s < strakes else 0.0
            pts_h.append((hb * (math.sin(v * math.pi * 0.5) ** 0.68) + lap, zb + (zt - zb) * (v**1.28)))
        full = [(-x, z) for x, z in reversed(pts_h[1:])] + pts_h
        r_o, r_i = [], []
        for x, z in full:
            nx = -1.0 if x < -0.02 else (1.0 if x > 0.02 else 0.0)
            ix = x - nx * wt * (0.85 if abs(x) > 0.08 else 0.0)
            iz = z + wt * (1.0 - 0.45 * abs(nx))
            r_o.append(bm.verts.new((x, y, z)))
            r_i.append(bm.verts.new((ix * 0.94, y + (0.04 if i == 0 else (-0.04 if i == stations else 0.0)), iz)))
        outer_g.append(r_o)
        inner_g.append(r_i)

    ncols = len(outer_g[0])
    for i in range(stations):
        for j in range(ncols - 1):
            bm.faces.new((outer_g[i][j], outer_g[i + 1][j], outer_g[i + 1][j + 1], outer_g[i][j + 1])).smooth = True
            bm.faces.new((inner_g[i][j], inner_g[i][j + 1], inner_g[i + 1][j + 1], inner_g[i + 1][j])).smooth = True
        bm.faces.new((outer_g[i][0], inner_g[i][0], inner_g[i + 1][0], outer_g[i + 1][0]))
        bm.faces.new((outer_g[i][ncols - 1], outer_g[i + 1][ncols - 1], inner_g[i + 1][ncols - 1], inner_g[i][ncols - 1]))

    for j in range(ncols - 1):
        bm.faces.new((outer_g[stations][j], inner_g[stations][j], inner_g[stations][j + 1], outer_g[stations][j + 1]))
        bm.faces.new((outer_g[0][j], outer_g[0][j + 1], inner_g[0][j + 1], inner_g[0][j]))
    mid_s = ncols // 2
    bm.faces.new((outer_g[stations][mid_s - 1], outer_g[stations][mid_s + 1], outer_g[stations][mid_s]))
    bm.faces.new((inner_g[stations][mid_s - 1], inner_g[stations][mid_s], inner_g[stations][mid_s + 1]))
    for d in range(2, mid_s + 1):
        bm.faces.new((outer_g[stations][mid_s - d], outer_g[stations][mid_s + d], outer_g[stations][mid_s + d - 1], outer_g[stations][mid_s - d + 1]))
        bm.faces.new((inner_g[stations][mid_s - d], inner_g[stations][mid_s - d + 1], inner_g[stations][mid_s + d - 1], inner_g[stations][mid_s + d]))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me_h = bpy.data.meshes.new("SkiffShell")
    bm.to_mesh(me_h)
    bm.free()
    ob_h = bpy.data.objects.new("SkiffShell", me_h)
    bpy.context.collection.objects.link(ob_h)
    ob_h.data.materials.append(m_cream)
    ob_h.parent = hull_root

    for side in (-1, 1):
        g_pts, s_pts = [], []
        for i in range(stations + 1):
            u = i / stations
            y = -2.02 + u * 3.84
            hb, zt = max(0.02, half_beam(u)), sheer_z(u)
            g_pts.append((side * (hb + 0.015), y, zt + 0.012))
            s_pts.append((side * (hb * 0.965), y, zt - 0.085))
        add_tube(f"Gunwale_{side}", g_pts, 0.032, m_teak, res_u=5, parent=hull_root)
        add_tube(f"Stripe_{side}", s_pts, 0.020, m_teal, res_u=5, parent=hull_root)

    add_tube("Keel", [(0, -2.04, 0.62), (0, -1.94, 0.12), (0, -1.55, -0.22), (0, 0, -0.25), (0, 1.55, -0.20), (0, 1.84, 0.02), (0, 1.86, 0.50)], 0.034, m_teak, res_u=5, parent=hull_root)
    for idx, x_off in enumerate((-0.24, -0.12, 0.0, 0.12, 0.24)):
        add_box(f"Duckboard_{idx}", (x_off, -0.02, 0.03), (0.088, 2.45 - abs(x_off) * 1.4, 0.024), m_cedar, bevel_w=0.005, parent=hull_root)

    add_box("CenterThwart", (0, 0.18, 0.34), (1.28, 0.34, 0.042), m_teak, bevel_w=0.01, parent=hull_root)
    add_box("RowerCushion", (0, 0.18, 0.375), (0.64, 0.28, 0.038), m_cush, bevel_w=0.012, parent=hull_root)
    add_box("PassengerThwart", (0, -0.90, 0.34), (1.06, 0.34, 0.042), m_teak, bevel_w=0.01, parent=hull_root)
    add_box("PassengerCushion", (0, -0.90, 0.375), (0.62, 0.28, 0.04), m_cush, bevel_w=0.012, parent=hull_root)
    add_box("SternThwart", (0, 1.34, 0.36), (0.94, 0.42, 0.042), m_teak, bevel_w=0.01, parent=hull_root)
    add_box("BowBreasthook", (0, -1.68, 0.54), (0.52, 0.52, 0.036), m_teak, bevel_w=0.01, parent=hull_root)

    for turn in range(3):
        rr = 0.09 + turn * 0.028
        pts = [(rr * math.cos(a), -1.62 + rr * math.sin(a), 0.572) for a in [k * math.tau / 16 for k in range(16)]]
        add_tube(f"BowRope_{turn}", pts, 0.013, m_rope, res_u=4, cyclic=True, parent=hull_root)

    add_tube("LanternArm", [(0, -1.78, 0.56), (0, -1.86, 0.78), (0, -1.96, 0.84), (0, -1.98, 0.78)], 0.014, m_brass, res_u=5, parent=hull_root)
    add_cyl("LanternCap", (0, -1.98, 0.75), 0.068, 0.035, m_brass, verts=10, r_top=0.02, parent=hull_root)
    add_cyl("LanternGlass", (0, -1.98, 0.69), 0.052, 0.09, m_glow, verts=10, bevel_w=0, parent=hull_root)

    for side in (-1, 1):
        ox, oy, oz = side * 0.68, -0.24, 0.505
        add_cyl(f"OarlockBase_{side}", (ox, oy, oz - 0.02), 0.026, 0.055, m_brass, verts=10, parent=hull_root)
        add_tube(
            f"OarlockU_{side}",
            [(ox, oy - 0.038, oz + 0.055), (ox, oy - 0.03, oz + 0.01), (ox, oy, oz), (ox, oy + 0.03, oz + 0.01), (ox, oy + 0.038, oz + 0.055)],
            0.011,
            m_brass,
            res_u=4,
            parent=hull_root,
        )

    hull_mesh = join_children_under_empty(hull_root, "Rowboat_Hull_Mesh")
    oar_meshes = add_articulated_oars(m_cedar, m_teak, m_cream, m_brass)
    bake_objects_to_single_pbr_atlas([hull_mesh] + oar_meshes, "VesselSkiff", res=1024, ao_samples=20, nor_samples=12)
    export_raw_glb(out_dir / "vessel-skiff.glb")


def build_vessel_sampan(out_dir: Path):
    """
    Traditional coastal wooden fishing sampan with upturned curved prow, woven bamboo aft/passenger canopy,
    warm bow lantern, rattan fishing baskets, preserving exact `Rowboat_Hull`, `Oar_L`, `Oar_R` (3 prims total!).
    """
    m_timber = make_proc_mat("SampanTimber", "#7d4928", "#4f2c16", rough=0.54, grain="wood", scale=6.5, bump_str=0.34)
    m_bamboo = make_proc_mat("SampanBamboo", "#cca258", "#8f6d32", rough=0.58, grain="bamboo", scale=8.5, bump_str=0.38)
    m_red = make_proc_mat("SampanLacquer", "#a83428", "#6e1e16", rough=0.40, grain="marine_enamel", scale=5.0, bump_str=0.12)
    m_brass = make_proc_mat("SampanBrass", "#d49b42", "#558074", rough=0.30, metal=0.85, grain="bronze_patina", scale=6.0, bump_str=0.15)
    m_glow = make_proc_mat("SampanGlow", "#ffd888", "#ffbe52", rough=0.22, grain="stone", em_hex="#ffbe52", em_str=2.5)

    hull_root = make_empty("Rowboat_Hull", (0, 0, 0))
    stations = 24
    bm = bmesh.new()
    og, ig = [], []
    for i in range(stations + 1):
        u = i / stations
        y = -2.25 + u * 4.35
        hb = max(0.03, 0.74 * math.sin(math.pi * (0.06 + 0.88 * u)) ** 0.65)
        zt = 0.44 + 0.34 * ((1.0 - min(1.0, u / 0.36)) ** 1.9) + 0.22 * (max(0.0, (u - 0.68) / 0.32) ** 1.7)
        zb = -0.19 + 0.22 * ((1.0 - min(1.0, u / 0.24)) ** 2.0) + 0.16 * (max(0.0, (u - 0.76) / 0.24) ** 1.8)
        # Flat-bottomed sampan dory cross-section
        prof = [(-hb, zt), (-hb * 0.82, zb + 0.08), (-hb * 0.48, zb), (hb * 0.48, zb), (hb * 0.82, zb + 0.08), (hb, zt)]
        ro, ri = [], []
        for x, z in prof:
            sx = -0.032 if x < 0 else 0.032
            ro.append(bm.verts.new((x, y, z)))
            ri.append(bm.verts.new((x - sx, y * 0.985, z + 0.034)))
        og.append(ro)
        ig.append(ri)

    nc = len(og[0])
    for i in range(stations):
        for j in range(nc - 1):
            bm.faces.new((og[i][j], og[i + 1][j], og[i + 1][j + 1], og[i][j + 1])).smooth = True
            bm.faces.new((ig[i][j], ig[i][j + 1], ig[i + 1][j + 1], ig[i + 1][j])).smooth = True
        bm.faces.new((og[i][0], ig[i][0], ig[i + 1][0], og[i + 1][0]))
        bm.faces.new((og[i][nc - 1], og[i + 1][nc - 1], ig[i + 1][nc - 1], ig[i][nc - 1]))
    for end_i, rev in ((0, False), (stations, True)):
        for j in range(nc - 1):
            if rev:
                bm.faces.new((og[end_i][j], ig[end_i][j], ig[end_i][j + 1], og[end_i][j + 1]))
            else:
                bm.faces.new((og[end_i][j], og[end_i][j + 1], ig[end_i][j + 1], ig[end_i][j]))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me_h = bpy.data.meshes.new("SampanHull")
    bm.to_mesh(me_h)
    bm.free()
    ob_h = bpy.data.objects.new("SampanHull", me_h)
    bpy.context.collection.objects.link(ob_h)
    ob_h.data.materials.append(m_timber)
    ob_h.parent = hull_root

    # Red lacquer prow band + traditional painted prow eyes
    add_box("ProwDeck", (0, -1.85, 0.56), (0.62, 0.62, 0.04), m_red, parent=hull_root)
    for side in (-1, 1):
        add_sphere(f"SampanEye_{side}", (side * 0.34, -1.88, 0.52), (0.025, 0.085, 0.045), m_glow, segs=10, rings=8, parent=hull_root)
        ox, oy, oz = side * 0.68, -0.24, 0.505
        add_cyl(f"SampanOarPin_{side}", (ox, oy, oz), 0.026, 0.08, m_brass, verts=10, parent=hull_root)

    # Rower & Passenger thwarts matching ROWER_SEAT (z=0.36 at y=+0.18) and PASSENGER_SEAT (z=0.36 at y=-0.90)
    add_box("RowerBench", (0, 0.18, 0.34), (1.26, 0.34, 0.045), m_timber, parent=hull_root)
    add_box("PassengerBench", (0, -0.90, 0.34), (1.14, 0.34, 0.045), m_timber, parent=hull_root)
    add_box("BambooFloor", (0, 0.0, 0.04), (0.78, 2.85, 0.03), m_bamboo, parent=hull_root)

    # Arched woven split-bamboo canopy over aft storage bay (y = +0.68 .. +1.78, completely clear of rower & oars!)
    bm_c = bmesh.new()
    na, ny = 12, 8
    cgrid = []
    for iy in range(ny + 1):
        vy = 0.66 + (iy / ny) * 1.14
        row = []
        for ia in range(na + 1):
            ang = math.pi * (ia / na)
            row.append(bm_c.verts.new((math.cos(ang) * 0.64, vy, 0.44 + math.sin(ang) * 0.68)))
        cgrid.append(row)
    for iy in range(ny):
        for ia in range(na):
            bm_c.faces.new((cgrid[iy][ia], cgrid[iy + 1][ia], cgrid[iy + 1][ia + 1], cgrid[iy][ia + 1])).smooth = True
    bmesh.ops.solidify(bm_c, geom=bm_c.faces[:] + bm_c.edges[:] + bm_c.verts[:], thickness=0.032)
    bmesh.ops.recalc_face_normals(bm_c, faces=bm_c.faces)
    me_c = bpy.data.meshes.new("SampanCanopy")
    bm_c.to_mesh(me_c)
    bm_c.free()
    can_ob = bpy.data.objects.new("SampanCanopy", me_c)
    bpy.context.collection.objects.link(can_ob)
    can_ob.data.materials.append(m_bamboo)
    can_ob.parent = hull_root

    # Rattan fish baskets + curved bamboo bow lantern pole
    for bx, by in ((-0.26, 1.15), (0.24, 1.32)):
        add_cyl(f"FishBasket_{bx}", (bx, by, 0.18), 0.19, 0.24, m_bamboo, verts=12, r_top=0.14, parent=hull_root)
    add_tube("BowPole", [(0, -1.92, 0.56), (0, -2.12, 0.96), (0, -2.24, 1.04), (0, -2.26, 0.95)], 0.018, m_bamboo, res_u=5, parent=hull_root)
    add_cyl("BowLantern", (0, -2.26, 0.86), 0.065, 0.14, m_glow, verts=10, bevel_w=0, parent=hull_root)

    hull_mesh = join_children_under_empty(hull_root, "Rowboat_Hull_Mesh")
    oar_meshes = add_articulated_oars(m_bamboo, m_timber, m_red, m_brass)
    bake_objects_to_single_pbr_atlas([hull_mesh] + oar_meshes, "VesselSampan", res=1024, ao_samples=20, nor_samples=12)
    export_raw_glb(out_dir / "vessel-sampan.glb")


def build_motorboat_variant(slug: str, style: str, out_dir: Path):
    """
    Builds `vessel-pelagic`, `vessel-tern`, and `vessel-cruiser`:
    Preserves EXACT `Hull` (0,0,0), `SteeringWheel`, `Outboard`, `Propeller` Empty pivot nodes
    while merging static body geometry down to <= 5 primitives total with baked 1K Marine PBR!
    """
    if style == "pelagic":
        hull_hex, stripe_hex, cush_hex = "#eeeae0", "#174854", "#cfb78d"
        L_scale, W_scale, roof_reach = 1.0, 1.0, 1.42
    elif style == "tern":
        hull_hex, stripe_hex, cush_hex = "#f2efe6", "#2b5884", "#dce0d5"
        L_scale, W_scale, roof_reach = 1.0, 1.0, 0.96
    else:  # cruiser (larger passenger launch!)
        hull_hex, stripe_hex, cush_hex = "#f4f1e8", "#1d6b78", "#d8be94"
        L_scale, W_scale, roof_reach = 1.22, 1.15, 2.05

    m_gel = make_proc_mat(f"{slug}_Gel", hull_hex, "#c9c4b8", rough=0.30, grain="marine_enamel", scale=5.0, bump_str=0.08)
    m_stripe = make_proc_mat(f"{slug}_Stripe", stripe_hex, "#0f2e36", rough=0.28, grain="marine_enamel", scale=5.0, bump_str=0.08)
    m_teak = make_proc_mat(f"{slug}_Teak", "#9c6b43", "#694427", rough=0.58, grain="wood", scale=8.0, bump_str=0.32)
    m_chrome = make_proc_mat(f"{slug}_Chrome", "#d2dcde", "#8f9fa3", rough=0.22, metal=0.90, grain="marine_enamel", scale=8.0, bump_str=0.05)
    m_rubber = make_proc_mat(f"{slug}_Rubber", "#263135", "#182023", rough=0.78, grain="stone", scale=10.0, bump_str=0.18)
    m_cush = make_proc_mat(f"{slug}_Cush", cush_hex, "#9c8663", rough=0.68, grain="fabric", scale=14.0, bump_str=0.18)
    m_port = make_proc_mat(f"{slug}_Port", "#d93829", "#961e14", rough=0.25, grain="stone", em_hex="#ff4533", em_str=2.0)
    m_star = make_proc_mat(f"{slug}_Star", "#2eb872", "#1c7849", rough=0.25, grain="stone", em_hex="#38e089", em_str=2.0)

    hull = make_empty("Hull", (0, 0, 0))
    hull_parts_empty = make_empty("_HullParts", (0, 0, 0), parent=hull)

    # Hard-chine marine hull loft (bow at -Y, stern at +Y, waterline Z = 0)
    verts, faces, f_mats = [], [], []
    count = 35
    for i in range(count):
        u = i / (count - 1)
        beam = 1.17 * W_scale * (1.0 - 0.12 * ((1.0 - u) ** 4)) * max(0.018, (1.0 - u**3.7) ** 0.64)
        y = (3.0 - 6.65 * u) * L_scale
        sheer = 0.65 + 0.29 * (u**4)
        section = [
            (0, -0.50 + 0.36 * (u**4)),
            (0.73, -0.13),
            (0.99, 0.31),
            (1.0, 0.48),
            (1.0, sheer),
            (0.91, sheer),
            (0.83, 0.31),
            (-0.83, 0.31),
            (-0.91, sheer),
            (-1.0, sheer),
            (-1.0, 0.48),
            (-0.99, 0.31),
            (-0.73, -0.13),
        ]
        n = len(section)
        for x, z in section:
            verts.append((x * beam, y, z))
        if i:
            for k in range(n):
                prev = (i - 1) * n + k
                after = (i - 1) * n + (k + 1) % n
                faces.append((prev, after, after + n, prev + n))
                f_mats.append(1 if k in (2, 3, 9, 10) else (2 if k == 6 else 0))
    n_sec = 13
    faces.extend([tuple(reversed(range(n_sec))), tuple(range((count - 1) * n_sec, count * n_sec))])
    f_mats.extend([0, 0])

    me_s = bpy.data.meshes.new(f"{slug}_Shell")
    me_s.from_pydata(verts, [], faces)
    me_s.update()
    ob_s = bpy.data.objects.new(f"{slug}_Shell", me_s)
    bpy.context.collection.objects.link(ob_s)
    ob_s.parent = hull_parts_empty
    for mt in (m_gel, m_stripe, m_teak):
        me_s.materials.append(mt)
    for p, sl in zip(me_s.polygons, f_mats):
        p.material_index = sl
        p.use_smooth = sl != 2

    # Helm console + chartplotter + throttle
    add_box("Console", (0, -0.22, 0.85), (0.82 * W_scale, 0.60, 1.08), m_gel, bevel_w=0.06, parent=hull_parts_empty)
    add_box("Plotter", (0, 0.085, 1.29), (0.34, 0.04, 0.19), m_rubber, parent=hull_parts_empty)
    add_box("PlotterScreen", (0, 0.108, 1.31), (0.28, 0.015, 0.13), m_stripe, parent=hull_parts_empty)
    add_tube("Throttle", [(0.33 * W_scale, 0.08, 1.12), (0.35 * W_scale, 0.20, 1.27)], 0.017, m_chrome, parent=hull_parts_empty)
    add_sphere("ThrottleKnob", (0.35 * W_scale, 0.20, 1.27), (0.04, 0.04, 0.05), m_rubber, parent=hull_parts_empty)
    for x in (-0.49 * W_scale, 0.49 * W_scale):
        add_tube(f"WindFrame_{x}", [(x, -0.42, 1.27), (x, -0.53, 1.85)], 0.018, m_chrome, parent=hull_parts_empty)

    # Seating layout (Cruiser gets dual facing lounge benches + forward sunpad!)
    seat_rows = (
        [(0.78, 0.68), (-1.45, 0.96), (-2.35, 0.72), (2.35, 1.65)]
        if style == "cruiser"
        else [(0.78, 0.58), (-1.64, 0.85), (2.12, 1.47)]
    )
    for sy, sw in seat_rows:
        add_box(f"Plinth_{sy}", (0, sy, 0.48), (sw * 0.84, 0.42, 0.34), m_gel, parent=hull_parts_empty)
        add_box(f"Cushion_{sy}", (0, sy, 0.73), (sw, 0.52, 0.15), m_cush, bevel_w=0.05, parent=hull_parts_empty)
        add_box(f"Bolster_{sy}", (0, sy + 0.23, 0.89), (sw, 0.13, 0.28), m_cush, bevel_w=0.04, parent=hull_parts_empty)

    if style == "cruiser":
        # Cruiser side passenger rails + orange lifebuoys
        m_buoy = make_proc_mat("CruiserBuoy", "#e85d26", "#f2efe6", rough=0.45, grain="marine_enamel", scale=6.0, bump_str=0.10)
        for side in (-1, 1):
            rx = side * 1.02 * W_scale
            add_tube(f"CruiserSideRail_{side}", [(rx, 2.2, 0.72), (rx, 2.2, 1.06), (rx, -0.8, 1.06), (rx, -0.8, 0.72)], 0.022, m_chrome, parent=hull_parts_empty)
            pts_b = [(rx + side * 0.04, 1.15 + 0.24 * math.cos(a), 0.92 + 0.24 * math.sin(a)) for a in [k * math.tau / 16 for k in range(16)]]
            add_tube(f"Lifebuoy_{side}", pts_b, 0.052, m_buoy, res_u=4, cyclic=True, parent=hull_parts_empty)

    # T-top / Cabin canopy + bow stainless rails + cleats + nav lights
    for x in (-0.76 * W_scale, 0.76 * W_scale):
        add_tube(
            f"CanopyFrame_{x}",
            [(x, 1.05 * L_scale, 0.37), (x * 0.92, 0.82 * L_scale, 2.18), (x * 0.92, 0.62 * L_scale, 2.38), (x * 0.92, -0.95 * L_scale, 2.38), (x, -1.12 * L_scale, 0.36)],
            0.036,
            m_chrome,
            parent=hull_parts_empty,
        )
    add_box("SunTop", (0, -0.09, 2.41), (1.86 * W_scale, roof_reach * 2.0, 0.11), m_stripe, bevel_w=0.04, parent=hull_parts_empty)

    for side in (-1, 1):
        add_tube(
            f"BowRail_{side}",
            [(side * 0.96 * W_scale, -1.22 * L_scale, 0.67), (side * 0.94 * W_scale, -1.38 * L_scale, 0.97), (side * 0.70 * W_scale, -2.35 * L_scale, 1.09), (side * 0.20 * W_scale, -3.24 * L_scale, 1.12)],
            0.022,
            m_chrome,
            parent=hull_parts_empty,
        )
        for cy in (-1.51 * L_scale, 2.26 * L_scale):
            add_box(f"Cleat_{side}_{cy}", (side * 0.92 * W_scale, cy, 0.73), (0.065, 0.23, 0.055), m_chrome, parent=hull_parts_empty)
        add_box(
            f"NavLight_{side}",
            (side * 0.92 * W_scale, -1.58 * L_scale, 0.75),
            (0.095, 0.12, 0.065),
            m_port if side < 0 else m_star,
            parent=hull_parts_empty,
        )

    hull_mesh = join_children_under_empty(hull_parts_empty, f"{slug}_HullBody_Mesh")
    hull_mesh.parent = hull
    bpy.data.objects.remove(hull_parts_empty, do_unlink=True)

    # Exact `SteeringWheel` Empty pivot at (0, 0.20, 1.19) -> Three.js (0, 1.19, -0.20)
    wheel = make_empty("SteeringWheel", (0, 0.20, 1.19), parent=hull)
    circle = [(0.205 * math.cos(a * math.tau / 28), 0, 0.205 * math.sin(a * math.tau / 28)) for a in range(28)]
    add_tube("WheelRim", circle, 0.022, m_rubber, res_u=4, cyclic=True, parent=wheel)
    for a in (0.0, 2.094, 4.188):
        add_tube(f"Spoke_{a:.1f}", [(0, 0, 0), (0.19 * math.cos(a), 0, 0.19 * math.sin(a))], 0.013, m_chrome, parent=wheel)
    wheel_mesh = join_children_under_empty(wheel, "SteeringWheel_Mesh")

    # Exact `Outboard` Empty pivot + child `Propeller` Empty pivot!
    outboard = make_empty("Outboard", (0, 3.08 * L_scale, 0.48), parent=hull)
    ob_parts = make_empty("_OutboardParts", (0, 0, 0), parent=outboard)
    add_box("EngineCowling", (0, 0.09, 0.17), (0.56, 0.62, 0.73), m_stripe, bevel_w=0.09, parent=ob_parts)
    add_box("CowlingCap", (0, 0.07, 0.53), (0.55, 0.61, 0.12), m_rubber, bevel_w=0.04, parent=ob_parts)
    add_box("ExhaustLeg", (0, 0.13, -0.36), (0.13, 0.20, 0.65), m_rubber, parent=ob_parts)
    add_box("CavPlate", (0, 0.14, -0.58), (0.37, 0.37, 0.04), m_chrome, parent=ob_parts)
    add_cyl("Gearcase", (0, 0.18, -0.66), 0.073, 0.26, m_rubber, verts=16, rot=(math.pi / 2, 0, 0), parent=ob_parts)
    outboard_mesh = join_children_under_empty(ob_parts, "Outboard_Mesh")
    outboard_mesh.parent = outboard
    bpy.data.objects.remove(ob_parts, do_unlink=True)

    prop = make_empty("Propeller", (0, 0.26, -0.66), parent=outboard)
    for a in range(3):
        ang = a * math.tau / 3.0
        add_sphere(
            f"Blade_{a}",
            (0.098 * math.sin(ang), 0, 0.098 * math.cos(ang)),
            (0.06, 0.025, 0.13),
            m_chrome,
            segs=10,
            rings=8,
            rot=(0.25, ang, 0.18),
            parent=prop,
        )
    prop_mesh = join_children_under_empty(prop, "Propeller_Mesh")

    # Bake all 4 opaque meshes into 1 shared 1024px Marine PBR Atlas!
    bake_objects_to_single_pbr_atlas([hull_mesh, wheel_mesh, outboard_mesh, prop_mesh], f"Motor_{slug}", res=1024, ao_samples=20, nor_samples=12)

    # Add 1 Fresnel Windscreen mesh under Hull -> Total = 5 primitives (<= 6 strict cap!)
    m_glass = make_fresnel_glass_mat(f"{slug}_Glass", "#90c8d2", alpha=0.28)
    add_box("Windscreen", (0, -0.47, 1.56), (0.98 * W_scale, 0.035, 0.56), m_glass, rot=(-0.18, 0, 0), bevel_w=0.015, parent=hull)

    export_raw_glb(out_dir / f"{slug}.glb")


def import_kenney_glb_from_zip(entry_name: str):
    with zipfile.ZipFile(KENNEY_WATERCRAFT_ZIP, "r") as zf:
        raw = zf.read(entry_name)
    with tempfile.NamedTemporaryFile(suffix=".glb", delete=False) as tf:
        tf.write(raw)
        tmp_p = tf.name
    try:
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=tmp_p)
        return [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    finally:
        if os.path.exists(tmp_p):
            os.remove(tmp_p)


def build_vessel_trawler(shared, out_dir: Path):
    """
    Coastal Wooden Fishing Trawler (9.2m) adapted from Kenney CC0 `boat-fishing-small.glb` +
    sculpted A-frame mast, booms, winch drum, buoys, warm cabin windows & Cycles OptiX 1K PBR!
    (2 draws LOD0 / 1 draw LOD1 for ambient sea lanes!)
    """
    m_hull = make_proc_mat("TrawlerHull", "#2d5c6e", "#1a3945", rough=0.48, grain="wood", scale=5.0, bump_str=0.35)
    m_deck = make_proc_mat("TrawlerDeck", "#96643c", "#633f22", rough=0.62, grain="wood", scale=7.0, bump_str=0.34)
    m_cabin = make_proc_mat("TrawlerCabin", "#ede6d6", "#bfb7a4", rough=0.46, grain="wood", scale=6.0, bump_str=0.20)
    m_steel = make_proc_mat("TrawlerSteel", "#495459", "#2a3136", rough=0.42, metal=0.78, grain="bronze_patina", scale=6.0, bump_str=0.20)
    m_buoy = make_proc_mat("TrawlerBuoy", "#e85d24", "#ab3c12", rough=0.38, grain="marine_enamel", scale=6.0, bump_str=0.10)
    m_glow = make_proc_mat("TrawlerWindow", "#ffe094", "#ffbe55", rough=0.20, grain="stone", em_hex="#ffbe55", em_str=2.2)

    k_meshes = import_kenney_glb_from_zip("Models/GLB format/boat-fishing-small.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for o in k_meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = k_meshes[0]
    if len(k_meshes) > 1:
        bpy.ops.object.join()
    base = bpy.context.view_layer.objects.active
    base.name = "KenneyTrawlerBase"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    # Scale Kenney hull to 8.8m length, bow along -Y, waterline at z = 0, stripping upper blocky cabin faces > 0.72m
    bb = [Vector(v.co) for v in base.data.vertices]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    if (hi.x - lo.x) > (hi.y - lo.y):
        base.data.transform(Matrix.Rotation(math.pi * 0.5, 4, "Z"))
        bb = [Vector(v.co) for v in base.data.vertices]
        lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
        hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    s = 8.8 / max(0.1, hi.y - lo.y)
    base.data.transform(Matrix.Scale(s, 4))
    bb2 = [Vector(v.co) for v in base.data.vertices]
    lo2 = Vector((min(v.x for v in bb2), min(v.y for v in bb2), min(v.z for v in bb2)))
    hi2 = Vector((max(v.x for v in bb2), max(v.y for v in bb2), max(v.z for v in bb2)))
    base.data.transform(Matrix.Translation(Vector((-(lo2.x + hi2.x) * 0.5, -(lo2.y + hi2.y) * 0.5, -lo2.z - 0.55))))
    bm_t = bmesh.new()
    bm_t.from_mesh(base.data)
    del_f = [f for f in bm_t.faces if f.calc_center_median().z > 0.92]
    if del_f:
        bmesh.ops.delete(bm_t, geom=del_f, context="FACES")
    bm_t.to_mesh(base.data)
    bm_t.free()
    base.data.materials.clear()
    base.data.materials.append(m_hull)
    for p in base.data.polygons:
        p.use_smooth = True

    objs = [base]
    # Add coastal trawler cabin trim, A-frame gantry mast, outriggers, winch, buoys & warm cabin windows!
    objs.append(add_box("WheelhouseTrim", (0, -1.15, 1.55), (2.15, 2.05, 1.55), m_cabin, bevel_w=0.03))
    objs.append(add_box("WheelhouseRoof", (0, -1.15, 2.38), (2.38, 2.28, 0.14), m_deck, bevel_w=0.02))
    objs.append(add_box("BridgeWindows", (0, -2.20, 1.82), (1.82, 0.08, 0.56), m_glow, bevel_w=0.01))
    objs.append(add_box("AftWorkDeck", (0, 1.55, 0.72), (2.35, 3.8, 0.10), m_deck))
    objs.append(add_cyl("TrawlWinch", (0, 0.85, 1.02), 0.28, 1.05, m_steel, verts=14, rot=(0, math.pi / 2, 0)))

    # A-frame steel gantry mast & outrigger booms
    for sx in (-0.92, 0.92):
        objs.append(add_tube(f"GantryLeg_{sx}", [(sx, 2.55, 0.72), (sx * 0.5, 2.35, 2.85), (0, 2.25, 4.45)], 0.058, m_steel, res_u=4))
        objs.append(add_tube(f"Outrigger_{sx}", [(sx * 0.55, 2.35, 2.45), (sx * 2.45, 1.95, 3.45)], 0.042, m_steel, res_u=4))
        objs.append(add_sphere(f"DeckBuoy_{sx}", (sx * 0.95, 3.05, 0.96), (0.24, 0.24, 0.28), m_buoy, segs=12, rings=8))

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    trawler = bpy.context.view_layer.objects.active
    trawler.name = "VesselTrawlerBody"
    bake_objects_to_single_pbr_atlas([trawler], "VesselTrawler", res=1024, ao_samples=20, nor_samples=12)

    # Draped trawl nets suspended from outriggers on LOD0 (named `TrawlerNet_LOD0Only` so LOD1 strips to 1 draw!)
    bm_n = bmesh.new()
    uv_n = bm_n.loops.layers.uv.new("UVMap")
    for sx in (-1, 1):
        v0 = bm_n.verts.new((sx * 0.45, 2.32, 2.55))
        v1 = bm_n.verts.new((sx * 2.15, 1.95, 3.38))
        v2 = bm_n.verts.new((sx * 1.18, 3.25, 0.98))
        v3 = bm_n.verts.new((sx * 0.35, 3.35, 0.90))
        f = bm_n.faces.new((v0, v1, v2, v3))
        for lp, uv_c in zip(f.loops, ((0, 0), (2, 0), (2, 2), (0, 2))):
            lp[uv_n].uv = uv_c
    me_n = bpy.data.meshes.new("TrawlerNet_LOD0Only")
    bm_n.to_mesh(me_n)
    bm_n.free()
    net_ob = bpy.data.objects.new("TrawlerNet_LOD0Only", me_n)
    bpy.context.collection.objects.link(net_ob)
    net_ob.data.materials.append(shared["fishing_net_mat"])

    export_raw_glb(out_dir / "vessel-trawler.glb")


def build_vessel_sailboat(out_dir: Path):
    """
    Coastal Bermudan Sloop Sailboat (8.6m hull, 9.8m mast) adapted from Kenney CC0 `boat-sail-a.glb` +
    sculpted billowing cream-and-coral sails, teak cockpit, mast rigging & Cycles OptiX 1K PBR (1 draw!).
    """
    m_hull = make_proc_mat("SailHull", "#1f456e", "#122a45", rough=0.32, grain="marine_enamel", scale=5.0, bump_str=0.10)
    m_teak = make_proc_mat("SailTeak", "#9e6b40", "#694426", rough=0.55, grain="wood", scale=7.0, bump_str=0.30)
    m_mast = make_proc_mat("SailMast", "#d8e0e3", "#98a4a8", rough=0.26, metal=0.86, grain="marine_enamel", scale=6.0, bump_str=0.06)
    m_sail = make_proc_mat("SailCloth", "#f7f1e1", "#ded4be", rough=0.68, grain="fabric", scale=12.0, bump_str=0.22)
    m_coral = make_proc_mat("SailAccent", "#d95638", "#9e3720", rough=0.66, grain="fabric", scale=12.0, bump_str=0.20)

    k_meshes = import_kenney_glb_from_zip("Models/GLB format/boat-sail-a.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for o in k_meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = k_meshes[0]
    if len(k_meshes) > 1:
        bpy.ops.object.join()
    base = bpy.context.view_layer.objects.active
    base.name = "KenneySailBase"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    bb = [Vector(v.co) for v in base.data.vertices]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    if (hi.x - lo.x) > (hi.y - lo.y):
        base.data.transform(Matrix.Rotation(math.pi * 0.5, 4, "Z"))
        bb = [Vector(v.co) for v in base.data.vertices]
        lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
        hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    s = 8.6 / max(0.1, hi.y - lo.y)
    base.data.transform(Matrix.Scale(s, 4))
    bb2 = [Vector(v.co) for v in base.data.vertices]
    lo2 = Vector((min(v.x for v in bb2), min(v.y for v in bb2), min(v.z for v in bb2)))
    hi2 = Vector((max(v.x for v in bb2), max(v.y for v in bb2), max(v.z for v in bb2)))
    base.data.transform(Matrix.Translation(Vector((-(lo2.x + hi2.x) * 0.5, -(lo2.y + hi2.y) * 0.5, -lo2.z - 0.58))))
    # Strip Kenney's blocky low-poly sail above gunwale (z > 0.88m) so our sculpted cambered Mainsail & Jib shine cleanly!
    bm_s = bmesh.new()
    bm_s.from_mesh(base.data)
    del_fs = [f for f in bm_s.faces if f.calc_center_median().z > 0.88]
    if del_fs:
        bmesh.ops.delete(bm_s, geom=del_fs, context="FACES")
    bm_s.to_mesh(base.data)
    bm_s.free()
    base.data.materials.clear()
    base.data.materials.append(m_hull)
    for p in base.data.polygons:
        p.use_smooth = True

    objs = [base]
    objs.append(add_box("TeakForedeck", (0, -1.65, 0.68), (1.65, 2.65, 0.06), m_teak))
    objs.append(add_box("CabinCoachroof", (0, -0.35, 0.96), (1.48, 1.95, 0.52), m_sail, bevel_w=0.04))
    objs.append(add_cyl("AluminumMast", (0, -0.85, 5.25), 0.068, 9.20, m_mast, verts=14, r_top=0.042))
    objs.append(add_cyl("MainsailBoom", (0, 1.05, 1.85), 0.048, 3.75, m_mast, verts=12, rot=(math.pi / 2, 0, 0)))

    # Standing rigging shrouds & forestay
    for sx in (-1.02, 1.02):
        objs.append(add_tube(f"Shroud_{sx}", [(sx, -0.85, 0.72), (0, -0.85, 8.85)], 0.012, m_mast, res_u=3))
    objs.append(add_tube("Forestay", [(0, -4.05, 0.82), (0, -0.85, 8.95)], 0.012, m_mast, res_u=3))

    # Sculpted billowing cambered Mainsail + Headsail Jib + Coral pennant stripe
    def make_cambered_sail(sname, p_tack, p_clew, p_head, mat_s, camber_x=0.32):
        bm = bmesh.new()
        nu, nv = 8, 10
        grid = []
        v_t, v_c, v_h = Vector(p_tack), Vector(p_clew), Vector(p_head)
        for iv in range(nv + 1):
            tv = iv / nv
            row = []
            for iu in range(nu + 1):
                tu = iu / nu * (1.0 - tv * 0.92)
                p = v_t * (1.0 - tu - tv) + v_c * tu + v_h * tv
                belly = camber_x * math.sin(math.pi * min(1.0, tu / max(0.08, 1.0 - tv))) * math.sin(math.pi * tv)
                row.append(bm.verts.new((p.x + belly, p.y, p.z)))
            grid.append(row)
        for iv in range(nv):
            for iu in range(nu):
                bm.faces.new((grid[iv][iu], grid[iv][iu + 1], grid[iv + 1][iu + 1], grid[iv + 1][iu])).smooth = True
        bmesh.ops.solidify(bm, geom=bm.faces[:] + bm.edges[:] + bm.verts[:], thickness=0.018)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me_sl = bpy.data.meshes.new(sname)
        bm.to_mesh(me_sl)
        bm.free()
        ob_sl = bpy.data.objects.new(sname, me_sl)
        bpy.context.collection.objects.link(ob_sl)
        ob_sl.data.materials.append(mat_s)
        return ob_sl

    objs.append(make_cambered_sail("Mainsail", (0, -0.78, 1.92), (0, 2.82, 1.92), (0, -0.80, 9.45), m_sail, camber_x=0.34))
    objs.append(make_cambered_sail("JibHeadsail", (0, -3.95, 0.92), (0, -1.05, 1.55), (0, -0.88, 8.65), m_coral, camber_x=0.26))

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    sailboat = bpy.context.view_layer.objects.active
    sailboat.name = "VesselSailboat"
    bake_objects_to_single_pbr_atlas([sailboat], "VesselSailboat", res=1024, ao_samples=20, nor_samples=12)
    export_raw_glb(out_dir / "vessel-sailboat.glb")


# ==============================================================================
# 8. CATEGORY 4 — INTERACTIVE FISHING & FRUIT PROPS + 4 TILEABLE PBR SETS
# ==============================================================================
def build_prop_fishing_rod(out_dir: Path):
    """Detailed golden-bamboo & carbon angling rod + machined brass spinning reel (Rod_Body, Reel_Crank, Rod_Tip)."""
    m_cork = make_proc_mat("RodCork", "#c89d68", "#967042", rough=0.82, grain="stone", scale=18.0, bump_str=0.30)
    m_bamboo = make_proc_mat("RodBamboo", "#ba8b3e", "#78551f", rough=0.34, grain="bamboo", scale=12.0, bump_str=0.20)
    m_carbon = make_proc_mat("RodCarbon", "#242c33", "#14191e", rough=0.26, metal=0.45, grain="marine_enamel", scale=12.0, bump_str=0.08)
    m_brass = make_proc_mat("RodBrass", "#d9a248", "#8f6524", rough=0.24, metal=0.90, grain="bronze_patina", scale=8.0, bump_str=0.10)

    rod_root = make_empty("Rod_Body", (0, 0, 0))
    r_parts = make_empty("_RodParts", (0, 0, 0), parent=rod_root)

    # Cork handle along -Y (Three.js +Z forward!) from y = +0.22 to y = -2.05
    add_cyl("CorkButt", (0, 0.12, 0), 0.018, 0.28, m_cork, verts=14, rot=(math.pi / 2, 0, 0), parent=r_parts)
    add_cyl("ReelSeat", (0, -0.08, 0), 0.016, 0.14, m_brass, verts=14, rot=(math.pi / 2, 0, 0), parent=r_parts)
    add_cyl("ForeGrip", (0, -0.22, 0), 0.017, 0.16, m_cork, verts=14, rot=(math.pi / 2, 0, 0), parent=r_parts)
    add_tube(
        "RodBlank",
        [(0, -0.30, 0), (0, -0.95, 0.01), (0, -1.55, 0.03), (0, -2.12, 0.06)],
        0.011,
        m_bamboo,
        res_u=8,
        bevel_res=2,
        taper_end=0.22,
        parent=r_parts,
    )
    # 5 ceramic/brass line guides
    for gy, gz, gr in ((-0.58, -0.025, 0.022), (-0.98, -0.015, 0.017), (-1.38, 0.005, 0.013), (-1.76, 0.028, 0.010), (-2.11, 0.056, 0.008)):
        pts = [(gr * math.cos(a), gy, gz + gr * math.sin(a)) for a in [k * math.tau / 12 for k in range(12)]]
        add_tube(f"Guide_{gy:.2f}", pts, 0.0025, m_brass, res_u=3, cyclic=True, parent=r_parts)

    # Spinning reel body under ReelSeat
    add_box("ReelFoot", (0, -0.08, -0.032), (0.014, 0.06, 0.05), m_carbon, parent=r_parts)
    add_cyl("ReelSpool", (0, -0.10, -0.068), 0.028, 0.055, m_brass, verts=16, rot=(math.pi / 2, 0, 0), parent=r_parts)
    add_cyl("ReelHousing", (0, -0.06, -0.068), 0.024, 0.045, m_carbon, verts=16, rot=(math.pi / 2, 0, 0), parent=r_parts)

    rod_mesh = join_children_under_empty(r_parts, "Rod_Body_Mesh")
    rod_mesh.parent = rod_root
    bpy.data.objects.remove(r_parts, do_unlink=True)

    crank = make_empty("Reel_Crank", (0.028, -0.06, -0.068), parent=rod_root)
    add_tube("CrankArm", [(0, 0, 0), (0.022, 0, -0.032), (0.035, 0, -0.032)], 0.004, m_brass, parent=crank)
    add_cyl("CrankKnob", (0.042, 0, -0.032), 0.009, 0.024, m_cork, verts=10, rot=(0, math.pi / 2, 0), parent=crank)
    crank_mesh = join_children_under_empty(crank, "Reel_Crank_Mesh")

    make_empty("Rod_Tip", (0, -2.12, 0.06), parent=rod_root)

    bake_objects_to_single_pbr_atlas([rod_mesh, crank_mesh], "PropFishingRod", res=512, ao_samples=16, nor_samples=10)
    export_raw_glb(out_dir / "prop-fishing-rod.glb")


def build_prop_bobber(out_dir: Path):
    """High-visibility red-and-pearl coastal fishing float/bobber (waterline centered at z = 0)."""
    m_red = make_proc_mat("BobberRed", "#e83424", "#ab1d12", rough=0.22, grain="marine_enamel", scale=8.0, bump_str=0.05)
    m_white = make_proc_mat("BobberPearl", "#f5f2ea", "#cfc9bc", rough=0.24, grain="marine_enamel", scale=8.0, bump_str=0.05)
    m_brass = make_proc_mat("BobberSwivel", "#d49b40", "#8a601e", rough=0.28, metal=0.88, grain="bronze_patina", scale=8.0, bump_str=0.10)

    objs = [
        add_sphere("BobberTopRed", (0, 0, 0.018), (0.052, 0.052, 0.048), m_red, segs=18, rings=10),
        add_sphere("BobberBotWhite", (0, 0, -0.018), (0.050, 0.050, 0.048), m_white, segs=18, rings=10),
        add_cyl("BobberAntenna", (0, 0, 0.095), 0.006, 0.095, m_red, verts=10, r_top=0.004, bevel_w=0),
        add_sphere("AntennaTip", (0, 0, 0.145), (0.011, 0.011, 0.014), m_red, segs=10, rings=8),
        add_cyl("BottomStem", (0, 0, -0.075), 0.007, 0.048, m_brass, verts=10, bevel_w=0),
    ]
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    bobber = bpy.context.view_layer.objects.active
    bobber.name = "PropBobber"
    bake_objects_to_single_pbr_atlas([bobber], "PropBobber", res=256, ao_samples=16, nor_samples=10)
    export_raw_glb(out_dir / "prop-bobber.glb")


def build_prop_fruits(out_dir: Path):
    """
    Multi-node tropical harvest pack preserving exact Empty parent nodes:
    `Fruit_Coconut`, `Fruit_Mango`, `Fruit_Banana`, `Fruit_Papaya` (1 child mesh each, 1 shared 512px PBR atlas!).
    """
    m_coco = make_proc_mat("FruitCoco", "#618532", "#3e591c", rough=0.42, grain="wood", scale=8.0, bump_str=0.18)
    m_mango = make_proc_mat("FruitMango", "#f29620", "#d93626", rough=0.30, grain="stone", scale=6.0, bump_str=0.08)
    m_banana = make_proc_mat("FruitBanana", "#f5cb28", "#b88b14", rough=0.36, grain="wood", scale=10.0, bump_str=0.10)
    m_papaya = make_proc_mat("FruitPapaya", "#eb8224", "#5c8c2b", rough=0.34, grain="stone", scale=7.0, bump_str=0.12)
    m_stem = make_proc_mat("FruitStem", "#523a22", "#332212", rough=0.78, grain="wood", scale=10.0, bump_str=0.25)

    fruit_meshes = []

    # 1. Fruit_Coconut
    e_coco = make_empty("Fruit_Coconut", (-0.30, 0, 0))
    add_sphere("CocoBody", (0, 0, 0.115), (0.105, 0.102, 0.115), m_coco, segs=16, rings=12, parent=e_coco)
    add_cyl("CocoCap", (0, 0, 0.228), 0.032, 0.018, m_stem, verts=10, parent=e_coco)
    fruit_meshes.append(join_children_under_empty(e_coco, "Fruit_Coconut_Mesh"))

    # 2. Fruit_Mango
    e_mango = make_empty("Fruit_Mango", (-0.09, 0, 0))
    add_sphere("MangoBody", (0, 0, 0.075), (0.068, 0.056, 0.092), m_mango, segs=16, rings=12, rot=(0.15, 0.08, 0), parent=e_mango)
    add_cyl("MangoStem", (0, -0.01, 0.168), 0.006, 0.025, m_stem, verts=8, parent=e_mango)
    fruit_meshes.append(join_children_under_empty(e_mango, "Fruit_Mango_Mesh"))

    # 3. Fruit_Banana (hand of 4 curved ripe bananas)
    e_ban = make_empty("Fruit_Banana", (0.11, 0, 0))
    add_box("BananaCrown", (0, -0.05, 0.125), (0.065, 0.035, 0.028), m_stem, parent=e_ban)
    for k in range(4):
        xo = (k - 1.5) * 0.026
        add_tube(
            f"BanFinger_{k}",
            [(xo, -0.045, 0.115), (xo * 1.15, 0.01, 0.038), (xo * 1.1, 0.075, 0.024), (xo * 0.95, 0.115, 0.055)],
            0.019,
            m_banana,
            res_u=5,
            bevel_res=2,
            taper_end=0.62,
            parent=e_ban,
        )
    fruit_meshes.append(join_children_under_empty(e_ban, "Fruit_Banana_Mesh"))

    # 4. Fruit_Papaya
    e_pap = make_empty("Fruit_Papaya", (0.33, 0, 0))
    add_sphere("PapayaBody", (0, 0, 0.115), (0.082, 0.082, 0.135), m_papaya, segs=16, rings=12, parent=e_pap)
    add_cyl("PapayaStem", (0, 0, 0.252), 0.012, 0.032, m_stem, verts=8, parent=e_pap)
    fruit_meshes.append(join_children_under_empty(e_pap, "Fruit_Papaya_Mesh"))

    bake_objects_to_single_pbr_atlas(fruit_meshes, "PropFruitsPack", res=512, ao_samples=16, nor_samples=10)
    export_raw_glb(out_dir / "prop-fruits.glb")


def build_raw_sand_golden_pbr(out_dir: Path):
    """Synthesizes seamless 1024x1024 rippled golden coral beach sand PNGs for Sharp WebP conversion."""
    S = 1024
    yy, xx = np.mgrid[0:S, 0:S].astype(np.float32) / S
    # Seamless periodic wind/wave sand ripples + multi-frequency shell/coral micro-grain
    warp = 0.045 * np.sin(xx * math.tau * 2.0 + 0.4) * np.cos(yy * math.tau * 2.0) + 0.02 * np.cos(xx * math.tau * 5.0 - yy * math.tau * 3.0)
    ripples = 0.5 + 0.5 * np.sin((yy + warp) * math.tau * 9.0)
    ripples = ripples**1.35
    rng_np = np.random.default_rng(20261122)
    grain_fine = rng_np.normal(0.0, 0.045, size=(S, S)).astype(np.float32)
    # Periodic smoothing of micro-grain
    grain_s = 0.25 * (grain_fine + np.roll(grain_fine, 1, 0) + np.roll(grain_fine, 1, 1) + np.roll(np.roll(grain_fine, 1, 0), 1, 1))
    shell_flecks = (rng_np.random((S, S)) > 0.992).astype(np.float32) * 0.14

    h = np.clip(0.68 * ripples + 0.32 * (0.5 + grain_s * 5.0) + shell_flecks, 0.0, 1.0)
    c_trough = np.array([0.76, 0.66, 0.49], dtype=np.float32)
    c_crest = np.array([0.91, 0.83, 0.67], dtype=np.float32)
    alb = c_trough[None, None, :] * (1.0 - h[..., None]) + c_crest[None, None, :] * h[..., None] + grain_s[..., None] * 0.4 + shell_flecks[..., None]

    alb_u8 = np.round(np.clip(alb, 0.0, 1.0) * 255).astype(np.uint8)
    nor_u8 = height_to_normal_u8(h, strength=3.6)
    orm_u8 = np.stack(
        [
            np.round(np.clip(0.76 + 0.24 * ripples, 0.72, 1.0) * 255).astype(np.uint8),
            np.round(np.clip(0.88 - 0.10 * ripples - shell_flecks * 1.5, 0.55, 0.94) * 255).astype(np.uint8),
            np.zeros((S, S), dtype=np.uint8),
        ],
        axis=-1,
    )

    pbr_raw = out_dir / "pbr_raw"
    pbr_raw.mkdir(parents=True, exist_ok=True)
    for suffix, arr, cs in (("color", alb_u8, "sRGB"), ("normal", nor_u8, "Non-Color"), ("orm", orm_u8, "Non-Color")):
        im = pack_np_image(f"_sand_{suffix}", arr, cs)
        im.filepath_raw = str(pbr_raw / f"sand_golden_{suffix}.png")
        im.file_format = "PNG"
        im.save()
        bpy.data.images.remove(im)
    print("[pbr-raw] Saved seamless 1024px sand_golden PNG set", flush=True)


# ==============================================================================
# 9. CYCLES OPTIX QA CONTACT SHEET TILE RENDERER (--qa-sheet MODE)
# ==============================================================================
def run_qa_sheet_render(manifest_path: Path, tiles_dir: Path):
    t0 = time.time()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    tiles_dir.mkdir(parents=True, exist_ok=True)

    setup_cycles_optix()
    scene = bpy.context.scene
    scene.cycles.samples = 24
    scene.cycles.transparent_max_bounces = 8
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"

    # Tropical midday HDRI world (`clarens_midday_1k.hdr`) + warm coastal sun
    world = scene.world
    nt = world.node_tree
    nt.nodes.clear()
    w_out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 0.72
    if CLARENS_HDR.exists():
        env_tex = nt.nodes.new("ShaderNodeTexEnvironment")
        env_tex.image = bpy.data.images.load(str(CLARENS_HDR))
        nt.links.new(env_tex.outputs["Color"], bg.inputs["Color"])
    else:
        bg.inputs["Color"].default_value = (0.72, 0.84, 0.96, 1.0)
    nt.links.new(bg.outputs["Background"], w_out.inputs["Surface"])

    sun_d = bpy.data.lights.new("QASun", type="SUN")
    sun_d.energy = 3.1
    sun_d.color = (1.0, 0.95, 0.86)
    sun_d.angle = math.radians(3.2)
    sun = bpy.data.objects.new("QASun", sun_d)
    sun.rotation_euler = (math.radians(46), math.radians(14), math.radians(-36))
    scene.collection.objects.link(sun)

    bpy.ops.mesh.primitive_plane_add(size=240.0, location=(0, 0, -0.005))
    floor = bpy.context.active_object
    floor.name = "QAFloor"
    fmat = bpy.data.materials.new("QAFloorMat")
    fmat.use_nodes = True
    fbsdf = fmat.node_tree.nodes.get("Principled BSDF")
    fbsdf.inputs["Base Color"].default_value = (0.64, 0.72, 0.76, 1.0)
    fbsdf.inputs["Roughness"].default_value = 0.78
    floor.data.materials.append(fmat)

    cam_d = bpy.data.cameras.new("QACam")
    cam_d.lens = 48.0
    cam_d.clip_start = 0.02
    cam_d.clip_end = 600.0
    cam = bpy.data.objects.new("QACam", cam_d)
    scene.collection.objects.link(cam)
    scene.camera = cam

    permanent_objs = {sun, floor, cam}
    assets_list = list(manifest["assets"].items())
    tiles_meta = []

    for slug, info in assets_list:
        # Remove previous asset objects
        for o in list(bpy.data.objects):
            if o not in permanent_objs:
                bpy.data.objects.remove(o, do_unlink=True)

        glb_abs = REPO_ROOT / "frontend" / "public" / info["lod0"]["url"].lstrip("/").replace("/", os.sep)
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(glb_abs))
        imported = [o for o in bpy.data.objects if o not in before]

        bpy.context.view_layer.update()
        min_v = Vector((1e9, 1e9, 1e9))
        max_v = Vector((-1e9, -1e9, -1e9))
        for o in imported:
            if o.type != "MESH":
                continue
            for corner in o.bound_box:
                wc = o.matrix_world @ Vector(corner)
                min_v.x = min(min_v.x, wc.x)
                min_v.y = min(min_v.y, wc.y)
                min_v.z = min(min_v.z, wc.z)
                max_v.x = max(max_v.x, wc.x)
                max_v.y = max(max_v.y, wc.y)
                max_v.z = max(max_v.z, wc.z)

        # Place floor cleanly at min_v.z (so boat keels sit in water-blue floor at z=0 or min_v.z!)
        floor.location.z = 0.0 if slug.startswith("vessel-") else min_v.z - 0.004

        ctr = (min_v + max_v) * 0.5
        radius = max(0.08, (max_v - min_v).length * 0.5)
        fov = 2.0 * math.atan(18.0 / cam_d.lens)
        dist = (radius / math.sin(fov * 0.5)) * 1.18
        az = math.radians(-38.0)
        el = math.radians(20.0)
        cam.location = ctr + Vector((math.sin(az) * math.cos(el) * dist, -math.cos(az) * math.cos(el) * dist, math.sin(el) * dist))
        cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()

        out_png = tiles_dir / f"{slug}.png"
        scene.render.filepath = str(out_png)
        bpy.ops.render.render(write_still=True)

        l0 = info["lod0"]
        l1 = info["lod1"]
        tiles_meta.append(
            {
                "slug": slug,
                "png": str(out_png),
                "label": slug,
                "sub": f"L0:{l0['tris']:,}t/{l0['prims']}p ({l0['bytes']//1024}KB) | L1:{l1['tris']:,}t/{l1['prims']}p",
            }
        )
        print(f"[qa-tile] Rendered {slug}", flush=True)

    (tiles_dir / "tiles.json").write_text(json.dumps(tiles_meta, indent=2), encoding="utf-8")
    print(f"[qa-sheet] Rendered {len(tiles_meta)} OptiX QA tiles in {time.time() - t0:.2f}s", flush=True)


# ==============================================================================
# 10. MAIN ORCHESTRATOR
# ==============================================================================
def main():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--out-dir", type=str, default="")
    parser.add_argument("--only", type=str, default="")
    parser.add_argument("--qa-sheet", action="store_true")
    parser.add_argument("--manifest", type=str, default="")
    parser.add_argument("--tiles-dir", type=str, default="")
    args = parser.parse_args(argv)

    if args.qa_sheet:
        run_qa_sheet_render(Path(args.manifest), Path(args.tiles_dir))
        return

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    only = {s.strip() for s in args.only.split(",") if s.strip()} if args.only else None

    t_start = time.time()
    setup_cycles_optix()
    shared, keep_imgs, keep_mats = build_shared_botanical_textures()

    tasks = [
        # 1. Tropical Vegetation Kit (10)
        ("palm-coconut-curved", lambda: build_palm_coconut_curved(shared, out_dir)),
        ("palm-royal-tall", lambda: build_palm_royal_tall(shared, out_dir)),
        ("tree-tropical-banyan", lambda: build_polyhaven_tree_variant(FACTORY_NATURE / "ph_tree_tropical_shade_a.glb", "tree-tropical-banyan", True, out_dir)),
        ("tree-tropical-canopy", lambda: build_polyhaven_tree_variant(FACTORY_NATURE / "ph_tree_tropical_shade_b.glb", "tree-tropical-canopy", False, out_dir)),
        ("tree-mango-fruiting", lambda: build_tree_mango_fruiting(shared, out_dir)),
        ("tree-banana-fruiting", lambda: build_tree_banana_fruiting(shared, out_dir)),
        ("bush-bougainvillea", lambda: build_flowering_bush("bush-bougainvillea", 2, 701, shared, out_dir)),
        ("bush-hibiscus", lambda: build_flowering_bush("bush-hibiscus", 3, 702, shared, out_dir)),
        ("fern-tropical-cluster", lambda: build_fern_tropical_cluster(out_dir)),
        ("grass-beach-dune", lambda: build_grass_beach_dune(shared, out_dir)),
        # 2. Archipelago Landmarks (8)
        ("karst-spire-tall", lambda: build_karst_spire_tall(out_dir)),
        ("karst-arch-cove", lambda: build_karst_arch_cove(out_dir)),
        ("rock-coastal-cluster", lambda: build_rock_coastal_cluster(out_dir)),
        ("pavilion-tropical-speaking", lambda: build_pavilion_tropical_speaking(out_dir)),
        ("village-stilt-house", lambda: build_village_stilt_house(shared, out_dir)),
        ("village-market-stall", lambda: build_village_market_stall(shared, out_dir)),
        ("harbor-whale-monument", lambda: build_harbor_whale_monument(out_dir)),
        ("harbor-lighthouse", lambda: build_harbor_lighthouse(out_dir)),
        # 3. Maritime Vessels (7)
        ("vessel-skiff", lambda: build_vessel_skiff(out_dir)),
        ("vessel-sampan", lambda: build_vessel_sampan(out_dir)),
        ("vessel-pelagic", lambda: build_motorboat_variant("vessel-pelagic", "pelagic", out_dir)),
        ("vessel-tern", lambda: build_motorboat_variant("vessel-tern", "tern", out_dir)),
        ("vessel-cruiser", lambda: build_motorboat_variant("vessel-cruiser", "cruiser", out_dir)),
        ("vessel-trawler", lambda: build_vessel_trawler(shared, out_dir)),
        ("vessel-sailboat", lambda: build_vessel_sailboat(out_dir)),
        # 4. Interactive Fishing & Fruit Props (3)
        ("prop-fishing-rod", lambda: build_prop_fishing_rod(out_dir)),
        ("prop-bobber", lambda: build_prop_bobber(out_dir)),
        ("prop-fruits", lambda: build_prop_fruits(out_dir)),
    ]

    for slug, fn in tasks:
        if only and slug not in only:
            continue
        clear_scene_keep_shared(keep_imgs, keep_mats)
        fn()

    if not only or "pbr" in only:
        clear_scene_keep_shared(keep_imgs, keep_mats)
        build_raw_sand_golden_pbr(out_dir)

    print(f"[ALL DONE] Blender 4.2 Cycles OptiX v7 batch completed in {time.time() - t_start:.2f}s", flush=True)


if __name__ == "__main__":
    main()
