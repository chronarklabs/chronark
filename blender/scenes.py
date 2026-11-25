# Tessera visuals: monochrome line-valley hero, orb, voxel cube, silver fins. Cycles.
import bpy, bmesh, math, sys, random, os, bisect
from mathutils import Vector
argv = sys.argv[sys.argv.index("--") + 1:]
SHOT, OUT = argv[0], argv[1]
PCT = int(argv[2]) if len(argv) > 2 else 100
SAMPLES = int(argv[3]) if len(argv) > 3 else 128

bpy.ops.wm.read_factory_settings(use_empty=True)
sc = bpy.context.scene
sc.render.engine = "CYCLES"
try:
    p = bpy.context.preferences.addons["cycles"].preferences; p.compute_device_type = "METAL"; p.get_devices()
    for d in p.devices: d.use = True
    sc.cycles.device = "GPU"
except Exception: pass
sc.cycles.samples = SAMPLES; sc.cycles.use_denoising = True
sc.view_settings.view_transform = "AgX"; sc.view_settings.look = "AgX - Medium High Contrast"
sc.render.film_transparent = False
w = bpy.data.worlds.new("w"); sc.world = w; w.use_nodes = True
w.node_tree.nodes["Background"].inputs[0].default_value = (0, 0, 0, 1)

def mat(name, base=(0.6, 0.6, 0.62), metal=1.0, rough=0.25, emit=None, estr=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*base, 1); b.inputs["Metallic"].default_value = metal; b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1); b.inputs["Emission Strength"].default_value = estr
    return m

def area(loc, target, power, size, shape="RECTANGLE", sy=None):
    l = bpy.data.lights.new("a", "AREA"); l.energy = power; l.shape = shape; l.size = size
    if sy: l.size_y = sy
    o = bpy.data.objects.new("a", l); sc.collection.objects.link(o); o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler(); return o

def camera(loc, target, lens=35, res=(1920, 1080), shift=(0, 0)):
    c = bpy.data.cameras.new("c"); c.lens = lens; c.shift_x, c.shift_y = shift
    o = bpy.data.objects.new("c", c); sc.collection.objects.link(o); o.location = loc
    o.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    sc.camera = o; sc.render.resolution_x, sc.render.resolution_y = res; sc.render.resolution_percentage = PCT

def glare(threshold=0.8, size=8, mix=0.0):
    return  # Blender 5 compositor API differs; bloom is added in post (PIL)
    rl = t.nodes.new("CompositorNodeRLayers"); g = t.nodes.new("CompositorNodeGlare"); o = t.nodes.new("CompositorNodeComposite")
    try:
        g.glare_type = "FOG_GLOW"; g.threshold = threshold; g.size = size; g.mix = mix
    except Exception:
        pass
    t.links.new(rl.outputs[0], g.inputs[0]); t.links.new(g.outputs[0], o.inputs[0])

def lines(name, fn, nu, nv, m, bevel=0.0035):
    cu = bpy.data.curves.new(name, "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = bevel; cu.bevel_resolution = 1
    for j in range(nv):
        s = cu.splines.new("POLY"); s.points.add(nu - 1)
        for i in range(nu):
            x, y, z = fn(i / (nu - 1), j / (nv - 1)); s.points[i].co = (x, y, z, 1)
    o = bpy.data.objects.new(name, cu); o.data.materials.append(m); sc.collection.objects.link(o); return o

# ---------------- hero: two swelling sheets of lines that fall into a dark valley, a beam in the middle ----------------
def shot_hero():
    M = mat("line", (0.75, 0.75, 0.78), metal=1.0, rough=0.3)
    def wing(side):
        def f(t, v):
            a = 1 - t
            # a fan of swooping curves stacked mostly in the screen plane, so the sheet faces the camera
            x = side * (0.45 + (9.5 + 6.0 * v) * a ** (1.15 + 0.5 * v) + 0.5 * math.sin(math.pi * t) * v)
            z = (5.0 + 9.0 * v) * a ** (1.7 + 0.6 * v) + 0.8 * v * a + 0.25 * math.sin(t * 7 + v * 5) * a * v
            y = 9.5 + 5.5 * v * a + 1.5 * t - 2.0 * v * math.sin(math.pi * a) * 0.6
            return x, y, z
        return f
    for side in (-1, 1):
        lines("wing%d" % side, wing(side), 300, 110, M, bevel=0.0075)
    bm = bmesh.new(); bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=60)
    me = bpy.data.meshes.new("floor"); bm.to_mesh(me); fl = bpy.data.objects.new("floor", me); sc.collection.objects.link(fl)
    fl.data.materials.append(mat("floor", (0.006, 0.006, 0.007), metal=0.0, rough=0.4))
    # perspective rays on the floor, fanning out from the beam toward the camera
    F = mat("ray", (0.32, 0.32, 0.34), metal=1.0, rough=0.35)
    def rays(u, v):
        ang = (v - 0.5) * 2.6
        r = 0.4 + 14 * u
        return math.sin(ang) * r, 9.6 - math.cos(ang) * r * 0.9, 0.004
    lines("rays", rays, 60, 220, F, bevel=0.0028)
    def dune(u, v):
        x = 2.0 + 9 * u; y = 9 + 10 * v
        return x, y, 0.9 * math.exp(-((x - 5.5) / 2.6) ** 2) * math.sin(math.pi * v) + 0.01
    lines("dune", dune, 120, 90, mat("dune", (0.3, 0.3, 0.32), metal=1.0, rough=0.45), bevel=0.004)
    area((0, 30, 16), (0, 12, 2), 3200, 16, sy=5)
    area((-12, 2, 10), (-4, 12, 3), 160, 6)
    area((12, 2, 10), (4, 12, 3), 160, 6)
    area((0, 9.6, 2.6), (0, 9.6, 0), 6, 0.4, "DISK")
    camera((0, -4.5, 2.2), (0, 10, 3.2), lens=24, res=(2560, 1600))


def cube(name, loc, size, m, rot=(0, 0, 0), bev=0.0):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=size); me = bpy.data.meshes.new(name); bm.to_mesh(me)
    o = bpy.data.objects.new(name, me); sc.collection.objects.link(o); o.location = loc; o.rotation_euler = rot; o.data.materials.append(m)
    if bev:
        b = o.modifiers.new("b", "BEVEL"); b.width = bev; b.segments = 3
    return o

def dust(n, box, m, r=0.006, seed=3):
    random.seed(seed)
    for k in range(n):
        bm = bmesh.new(); bmesh.ops.create_icosphere(bm, subdivisions=1, radius=r * random.uniform(0.5, 1.6))
        me = bpy.data.meshes.new("d"); bm.to_mesh(me); o = bpy.data.objects.new("d", me); sc.collection.objects.link(o)
        o.location = [random.uniform(a, b) for a, b in box]; o.data.materials.append(m)

# ---------------- voxel cube, a few blocks pulled out (card: run + sign) ----------------
def shot_cube():
    M = mat("vox", (0.55, 0.55, 0.58), metal=1.0, rough=0.32)
    D = mat("vox_d", (0.12, 0.12, 0.13), metal=1.0, rough=0.4)
    random.seed(7); n = 5; s_ = 0.2; g = 0.012
    for i in range(n):
        for j in range(n):
            for k in range(n):
                if 0 < i < n - 1 and 0 < j < n - 1 and 0 < k < n - 1: continue
                r = random.random()
                if r < 0.1: continue
                off = Vector((0, 0, 0))
                if r > 0.93: off = Vector((random.uniform(-.15, .15), random.uniform(-.15, .15), random.uniform(.05, .3)))
                loc = Vector(((i - 2) * (s_ + g), (j - 2) * (s_ + g), (k - 2) * (s_ + g))) + off
                cube("v", loc, s_, M if random.random() > 0.25 else D, bev=0.006)
    dust(160, [(-1.6, 1.6), (-1.6, 1.6), (-1.2, 1.6)], mat("dust", (1, 1, 1), 0, 0.5, emit=(1, 1, 1), estr=2.0), 0.005)
    area((-3, -3, 4), (0, 0, 0), 700, 3); area((3, 2, 3), (0, 0, 0), 300, 3); area((0, 4, -2), (0, 0, 0), 200, 3)
    camera((3.4, -3.6, 2.6), (0, 0, 0.05), lens=75, res=(1200, 1200))

# ---------------- dark orb (card: choose a worker) ----------------
def shot_orb():
    bm = bmesh.new(); bmesh.ops.create_uvsphere(bm, u_segments=96, v_segments=48, radius=1)
    me = bpy.data.meshes.new("orb"); bm.to_mesh(me); o = bpy.data.objects.new("orb", me); sc.collection.objects.link(o)
    for f in me.polygons: f.use_smooth = True
    o.data.materials.append(mat("orb", (0.05, 0.05, 0.055), metal=0.4, rough=0.55))
    area((-2.5, -1, 3), (0, 0, 0), 120, 2.5); area((2.5, 2, 1), (0, 0, 0), 160, 2); area((0, -4, -1), (0, 0, 0), 15, 4)
    camera((0, -6, 0), (0, 0, 0), lens=60, res=(1000, 1000))

# ---------------- fanned silver blades (card: signed receipts) ----------------
def shot_fins():
    M = mat("fin", (0.78, 0.78, 0.8), metal=1.0, rough=0.16)
    for k in range(26):
        a = -1.25 + 2.5 * k / 25
        bm = bmesh.new(); verts = []
        nu, nv = 40, 8
        for i in range(nu):
            t = i / (nu - 1)
            for j in range(nv):
                w = (j / (nv - 1) - 0.5) * 0.55 * math.sin(math.pi * min(1, t * 1.15))
                verts.append(bm.verts.new((w, 0.6 * t ** 2 * 0.6, 2.4 * t)))
        for i in range(nu - 1):
            for j in range(nv - 1):
                bm.faces.new((verts[i * nv + j], verts[i * nv + j + 1], verts[(i + 1) * nv + j + 1], verts[(i + 1) * nv + j]))
        me = bpy.data.meshes.new("fin"); bm.to_mesh(me); o = bpy.data.objects.new("fin", me); sc.collection.objects.link(o)
        for f in me.polygons: f.use_smooth = True
        sol = o.modifiers.new("s", "SOLIDIFY"); sol.thickness = 0.02
        o.rotation_euler = (math.radians(-18 + 10 * abs(a)), a * 0.55, a * 0.25); o.location = (a * 0.5, 0.2 * abs(a), 0)
        o.data.materials.append(M)
    area((0, -4, 6), (0, 0, 1.4), 900, 4); area((-4, 1, 2), (0, 0, 1.4), 300, 3); area((4, 3, 3), (0, 0, 1.4), 250, 3)
    camera((0, -6.0, 1.6), (0, 0, 1.55), lens=62, res=(1600, 900))


# ---------------- hero v2: a striped valley. walls and floor share one set of lines running toward the vanishing point ----------------
def shot_valley():
    import bmesh as _bm
    NX, NY = 520, 300
    X0, X1, Y0, Y1 = -26.0, 26.0, 1.0, 70.0
    def H(x, y):
        ax = abs(x)
        side = 1 if x > 0 else -1
        # wall height: tall near the camera, falling into the distance; left a touch taller
        peak = (11.0 if side < 0 else 9.5) * math.exp(-(y - 1) / (13.0 if side < 0 else 15.0)) + 0.4
        start = 2.2 + 0.05 * y                       # valley floor half-width grows a little with depth
        t = max(0.0, (ax - start) / (7.5 + 0.12 * y))
        wall = peak * (1 - math.exp(-2.2 * t * t)) if t > 0 else 0.0
        # soft wave along the wall
        wall *= 1 + 0.08 * math.sin(y * 0.35 + ax * 0.3)
        dune = 1.6 * math.exp(-((x - 7.5) / 3.2) ** 2 - ((y - 30) / 6.0) ** 2)
        return wall + dune
    bm = _bm.new(); vs = []
    for j in range(NY):
        v = j / (NY - 1); y = Y0 + (Y1 - Y0) * v ** 1.6
        row = []
        for i in range(NX):
            u = i / (NX - 1); x = X0 + (X1 - X0) * u
            row.append(bm.verts.new((x, y, H(x, y))))
        vs.append(row)
    for j in range(NY - 1):
        for i in range(NX - 1):
            bm.faces.new((vs[j][i], vs[j][i + 1], vs[j + 1][i + 1], vs[j + 1][i]))
    me = bpy.data.meshes.new("valley"); bm.to_mesh(me)
    for f in me.polygons: f.use_smooth = True
    o = bpy.data.objects.new("valley", me); sc.collection.objects.link(o)
    # stripes: bands on object X (lines run along Y, so they converge on the vanishing point)
    m = bpy.data.materials.new("stripes"); m.use_nodes = True; nt = m.node_tree
    b = nt.nodes["Principled BSDF"]; b.inputs["Metallic"].default_value = 0.0; b.inputs["Roughness"].default_value = 0.42
    tc = nt.nodes.new("ShaderNodeTexCoord"); sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mul = nt.nodes.new("ShaderNodeMath"); mul.operation = "MULTIPLY"; mul.inputs[1].default_value = 9.0
    sn = nt.nodes.new("ShaderNodeMath"); sn.operation = "SINE"
    mr = nt.nodes.new("ShaderNodeMapRange"); mr.inputs[1].default_value = -1; mr.inputs[2].default_value = 1
    mr.inputs[3].default_value = 0.035; mr.inputs[4].default_value = 0.16
    bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.25
    L = nt.links.new
    L(tc.outputs["Object"], sep.inputs[0]); L(sep.outputs[0], mul.inputs[0]); L(mul.outputs[0], sn.inputs[0]); L(sn.outputs[0], mr.inputs[0])
    L(mr.outputs[0], b.inputs["Base Color"]); L(sn.outputs[0], bump.inputs["Height"]); L(bump.outputs[0], b.inputs["Normal"])
    o.data.materials.append(m)
    # light: a wide glow at the far end of the valley grazes the walls; a soft top light shapes the crests
    area((0, 75, 6), (0, 0, 2), 60000, 30, sy=8)
    area((0, 8, 30), (0, 20, 0), 2500, 30)
    area((0, 22, 1.4), (0, 0, 1.0), 400, 2.5)          # glow where the beam meets the floor
    camera((0, -3.0, 1.35), (0, 30, 2.6), lens=22, res=(2880, 1600))


# ---------------- hero v3: a dark conveyor belt snaking through the dark, packets riding on it ----------------
def _catmull(pts, n):
    P = [Vector(p) for p in pts]; out = []
    P = [P[0] + (P[0] - P[1])] + P + [P[-1] + (P[-1] - P[-2])]
    seg = len(P) - 3
    for k in range(n):
        f = k / (n - 1) * seg; i = min(int(f), seg - 1); t = f - i
        p0, p1, p2, p3 = P[i], P[i + 1], P[i + 2], P[i + 3]
        out.append(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t ** 3))
    return out

def shot_belt():
    path = _catmull([(-11, -1.2, 0), (-5, -1.65, 0), (-0.8, -1.9, 0), (1.05, -1.35, 0), (1.75, 0.15, 0), (2.45, 1.45, 0),
                     (3.9, 1.95, 0), (7, 1.55, 0), (13, 0.5, 0)], 1100)
    # even out the path: resample by arc length, then relax it so the bend has no wobble and a clean radius
    def _resample(P, n):
        L = [0.0]
        for k in range(1, len(P)): L.append(L[-1] + (P[k] - P[k - 1]).length)
        out = []; j = 0
        for i in range(n):
            d = L[-1] * i / (n - 1)
            while j < len(L) - 2 and L[j + 1] < d: j += 1
            t = (d - L[j]) / max(1e-9, L[j + 1] - L[j]); out.append(P[j].lerp(P[j + 1], t))
        return out
    path = _resample(path, 1400)
    for _ in range(160):
        path = [path[0]] + [(path[k - 1] + path[k] * 2 + path[k + 1]) / 4 for k in range(1, len(path) - 1)] + [path[-1]]
    path = _resample(path, 1400)
    Wd, Ht = 1.02, 0.3
    rmin = 1e9
    for k in range(2, len(path) - 2):
        a_, b_, c_ = path[k - 2], path[k], path[k + 2]
        ab, bc = (b_ - a_), (c_ - b_); cr = abs(ab.x * bc.y - ab.y * bc.x)
        if cr > 1e-12: rmin = min(rmin, ab.length * bc.length * (c_ - a_).length / (2 * cr))
    print("BEND_RADIUS_MIN", round(rmin, 3), "HALF_WIDTH", Wd / 2)
    bm = bmesh.new(); rows = []; uvs = []; acc = 0.0
    for k, p in enumerate(path):
        tng = (path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]).normalized()
        nrm = Vector((-tng.y, tng.x, 0))
        if k: acc += (path[k] - path[k - 1]).length
        L_, R_ = p + nrm * Wd / 2, p - nrm * Wd / 2
        rows.append([bm.verts.new((L_.x, L_.y, 0)), bm.verts.new((L_.x, L_.y, Ht)), bm.verts.new((R_.x, R_.y, Ht)), bm.verts.new((R_.x, R_.y, 0))])
        uvs.append(acc)
    uvl = bm.loops.layers.uv.new("UVMap")
    for k in range(len(rows) - 1):
        a, b = rows[k], rows[k + 1]
        for q, (i0, i1) in enumerate(((0, 1), (1, 2), (2, 3))):
            f = bm.faces.new((a[i0], b[i0], b[i1], a[i1]))
            for lp in f.loops:
                kk = k if lp.vert in a else k + 1
                idx = (a if lp.vert in a else b).index(lp.vert)
                lp[uvl].uv = (uvs[kk], idx / 3.0)
    me = bpy.data.meshes.new("belt"); bm.to_mesh(me)
    for f in me.polygons: f.use_smooth = False
    belt = bpy.data.objects.new("belt", me); sc.collection.objects.link(belt)
    # belt material: dark rubber with fine slats across the run
    m = bpy.data.materials.new("belt"); m.use_nodes = True; nt = m.node_tree; b = nt.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.022, 0.027, 0.03, 1); b.inputs["Roughness"].default_value = 0.3; b.inputs["Metallic"].default_value = 0.4
    uv = nt.nodes.new("ShaderNodeUVMap"); sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    def M_(op, a=None, b_=None):
        n = nt.nodes.new("ShaderNodeMath"); n.operation = op
        if a is not None: n.inputs[0].default_value = a
        if b_ is not None: n.inputs[1].default_value = b_
        return n
    L = nt.links.new
    L(uv.outputs[0], sep.inputs[0])
    ku = M_("MULTIPLY", b_=380); kv = M_("MULTIPLY", b_=420)
    off = M_("ADD", b_=0.0); off.name = "belt_offset"
    L(sep.outputs[0], off.inputs[0]); L(off.outputs[0], ku.inputs[0]); L(sep.outputs[1], kv.inputs[0])
    d1 = M_("ADD"); d2 = M_("SUBTRACT"); L(ku.outputs[0], d1.inputs[0]); L(kv.outputs[0], d1.inputs[1]); L(ku.outputs[0], d2.inputs[0]); L(kv.outputs[0], d2.inputs[1])
    s1 = M_("SINE"); s2 = M_("SINE"); L(d1.outputs[0], s1.inputs[0]); L(d2.outputs[0], s2.inputs[0])
    hh = M_("MULTIPLY"); L(s1.outputs[0], hh.inputs[0]); L(s2.outputs[0], hh.inputs[1])
    bump = nt.nodes.new("ShaderNodeBump"); bump.inputs["Strength"].default_value = 0.6; bump.inputs["Distance"].default_value = 0.02
    L(hh.outputs[0], bump.inputs["Height"]); L(bump.outputs[0], b.inputs["Normal"])
    cr = nt.nodes.new("ShaderNodeMapRange"); cr.inputs[1].default_value = -1; cr.inputs[2].default_value = 1
    cr.inputs[3].default_value = 0.07; cr.inputs[4].default_value = 0.2
    L(hh.outputs[0], cr.inputs[0]); L(cr.outputs[0], b.inputs["Base Color"])
    belt.data.materials.append(m)
    # glowing rails on both top edges
    E = mat("rail", (0.6, 0.85, 0.85), metal=0, rough=0.4, emit=(0.6, 0.95, 0.92), estr=1.1)
    for sgn in (1, -1):
        cu = bpy.data.curves.new("rail", "CURVE"); cu.dimensions = "3D"; cu.bevel_depth = 0.045; cu.bevel_resolution = 2
        sp = cu.splines.new("POLY"); sp.points.add(len(path) - 1)
        for k, p in enumerate(path):
            tng = (path[min(k + 1, len(path) - 1)] - path[max(k - 1, 0)]).normalized(); nrm = Vector((-tng.y, tng.x, 0))
            q = p + nrm * (Wd / 2 + 0.004) * sgn; sp.points[k].co = (q.x, q.y, 0.09, 1)
        o = bpy.data.objects.new("rail", cu); o.data.materials.append(E); sc.collection.objects.link(o)
    # packets riding the belt
    def packet(t, col, strength):
        k = int(t * (len(path) - 1)); p = path[k]
        tng = (path[k + 1] - path[k - 1]).normalized()
        c = cube("pk", (p.x, p.y, Ht + 0.1), 0.2, mat("pk%d" % k, col, metal=0, rough=0.4, emit=col, estr=strength), bev=0.02)
        c.rotation_euler = (0, 0, math.atan2(tng.y, tng.x))
        l = bpy.data.lights.new("pl", "POINT"); l.energy = 8; l.color = col; l.shadow_soft_size = 0.2
        lo = bpy.data.objects.new("pl", l); sc.collection.objects.link(lo); lo.location = (p.x, p.y, Ht + 0.35)
    if not os.environ.get("BELT_ANIM"):
        packet(0.16, (0.92, 0.97, 1.0), 7)
        packet(0.522, (1.0, 0.68, 0.42), 6)
        packet(0.745, (0.92, 0.97, 1.0), 5)
    else:
        # looping conveyor: packets every S units, colour pattern repeats every 3, the loop travels exactly 3*S,
        # and 3*S is a whole number of weave periods so the belt texture also lands back where it started
        D = 907 * 2 * math.pi / 380; S_ = D / 3
        def at(dist):
            k = max(1, min(len(uvs) - 2, bisect.bisect_left(uvs, dist)))
            p = path[k]; tng = (path[k + 1] - path[k - 1]).normalized(); return p, math.atan2(tng.y, tng.x)
        d0 = uvs[int(0.16 * (len(path) - 1))]
        items = []
        i0 = -int(d0 / S_) - 4
        for i in range(i0, i0 + int(uvs[-1] / S_) + 8):
            dist = d0 + i * S_
            col, strength = ((1.0, 0.68, 0.42), 6) if (i % 3) == 1 else ((0.92, 0.97, 1.0), 7)
            c = cube("pk", (0, 0, Ht + 0.1), 0.2, mat("pk%d" % i, col, metal=0, rough=0.4, emit=col, estr=strength), bev=0.02)
            l = bpy.data.lights.new("pl", "POINT"); l.energy = 8; l.color = col; l.shadow_soft_size = 0.2
            lo = bpy.data.objects.new("pl", l); sc.collection.objects.link(lo)
            items.append((dist, c, lo))
        def set_frame(f, n):
            travel = D * f / n
            for dist, c, lo in items:
                d = dist + travel
                hide = d < 0.05 or d > uvs[-1] - 0.05
                c.hide_render = lo.hide_render = hide
                if hide: continue
                p, ang = at(d)
                c.location = (p.x, p.y, Ht + 0.1); c.rotation_euler = (0, 0, ang); lo.location = (p.x, p.y, Ht + 0.35)
            m.node_tree.nodes["belt_offset"].inputs[1].default_value = -travel
        global BELT_SET
        BELT_SET = set_frame
    # floor: near-black, slightly glossy, to catch the rails
    bmf = bmesh.new(); bmesh.ops.create_grid(bmf, x_segments=1, y_segments=1, size=80)
    mf = bpy.data.meshes.new("floor"); bmf.to_mesh(mf); fl = bpy.data.objects.new("floor", mf); sc.collection.objects.link(fl)
    fl.data.materials.append(mat("floor", (0.01, 0.011, 0.012), metal=0.0, rough=0.48))
    area((1, 9, 9), (1, 0, 0), 380, 10, sy=3).data.color = (0.55, 0.85, 0.85)
    area((-6, -4, 6), (0, -2, 0), 60, 6).data.color = (0.7, 0.85, 0.9)
    camera((-1.7, -14.6, 8.4), (1.3, 0.9, -0.3), lens=40, res=(2880, 1724), shift=(-0.035, 0.148))

{"belt": shot_belt, "valley": shot_valley, "hero": shot_hero, "cube": shot_cube, "orb": shot_orb, "fins": shot_fins}[SHOT]()
sc.render.image_settings.file_format = "PNG"
if os.environ.get("BELT_ANIM"):
    n = int(os.environ["BELT_ANIM"]); a_, b_ = [int(x) for x in os.environ.get("BELT_RANGE", "0-%d" % (n - 1)).split("-")]
    os.makedirs(OUT, exist_ok=True)
    for f in range(a_, b_ + 1):
        fp = os.path.join(OUT, "f%04d.png" % f)
        if os.path.exists(fp): continue
        BELT_SET(f, n); sc.render.filepath = fp
        bpy.ops.render.render(write_still=True); print("WROTE", fp, flush=True)
else:
    sc.render.filepath = OUT
    bpy.ops.render.render(write_still=True); print("WROTE", OUT)
