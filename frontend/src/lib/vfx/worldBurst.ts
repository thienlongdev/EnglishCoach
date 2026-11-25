import { VFX_BUDGET, VfxQuality, vfxReduced } from './quality';

/** One temporary GPU pass on the existing Living World/Spatial context. No renderer or animation loop. */
export class WorldBurst {
  private program: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private buffer: WebGLBuffer;
  private quality = new VfxQuality();
  private count = VFX_BUDGET.ultra.particles;
  private started = performance.now();
  constructor(private gl: WebGL2RenderingContext) {
    const vertex = `#version 300 es
precision highp float;in float seed;uniform float age,aspect,pixel;out float life,hue;
void main(){float t=age-fract(seed*11.)*.18;float a=seed*333.+t*.7;float g=1.-smoothstep(0.,.95,t),r=smoothstep(.8,1.65,t);float radius=(.45+fract(seed*31.7)*.55)*(g+r*(.5+max(0.,t-1.6)*.22));
vec2 p=vec2(cos(a)*radius,sin(a)*radius*.4+r*(.1+fract(seed*23.1)*.65)+max(0.,t-1.8)*.12);p*=.68;p.x/=aspect;gl_Position=vec4(p,0.,1.);gl_PointSize=(2.+fract(seed*13.)*3.5)*pixel;life=smoothstep(0.,.2,t)*(1.-smoothstep(2.1,3.8,t));hue=fract(seed*13.);}`;
    const fragment = `#version 300 es
precision highp float;in float life,hue;out vec4 color;void main(){float r=length(gl_PointCoord-.5);if(r>.5)discard;float a=(exp(-r*r*20.)*.5+pow(max(0.,1.-r*2.),4.))*life*.65;color=vec4(mix(vec3(.5,.95,.86),vec3(1.,.79,.38),smoothstep(.65,.95,hue))*a,a);}`;
    const compile = (type: number, code: string) => {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, code); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); throw new Error('VFX shader unavailable'); }
      return shader;
    };
    const vs = compile(gl.VERTEX_SHADER, vertex), fs = compile(gl.FRAGMENT_SHADER, fragment);
    this.program = gl.createProgram()!; gl.attachShader(this.program, vs); gl.attachShader(this.program, fs); gl.linkProgram(this.program); gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) { gl.deleteProgram(this.program); throw new Error('VFX program unavailable'); }
    const oldVao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), oldBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
    this.vao = gl.createVertexArray()!; this.buffer = gl.createBuffer()!;
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // The irrational stride distributes every adaptive prefix across the entire effect.
    gl.bufferData(gl.ARRAY_BUFFER, Float32Array.from({ length: this.count }, (_, i) => ((i + .5) * .61803398875) % 1), gl.STATIC_DRAW);
    const location = gl.getAttribLocation(this.program, 'seed'); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 1, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(oldVao); gl.bindBuffer(gl.ARRAY_BUFFER, oldBuffer);
  }
  draw(now: number, dt: number): boolean {
    const age = (now - this.started) / 1000;
    if (age >= 4 || document.hidden || vfxReduced()) return false;
    const gl = this.gl;
    const program = gl.getParameter(gl.CURRENT_PROGRAM), vao = gl.getParameter(gl.VERTEX_ARRAY_BINDING), fb = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING), viewport = gl.getParameter(gl.VIEWPORT);
    const flags = [gl.BLEND, gl.DEPTH_TEST, gl.CULL_FACE, gl.SCISSOR_TEST], enabled = flags.map(flag => gl.isEnabled(flag));
    const mask = gl.getParameter(gl.COLOR_WRITEMASK), depthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
    const blend = [gl.BLEND_SRC_RGB, gl.BLEND_DST_RGB, gl.BLEND_SRC_ALPHA, gl.BLEND_DST_ALPHA, gl.BLEND_EQUATION_RGB, gl.BLEND_EQUATION_ALPHA].map(p => gl.getParameter(p));
    try {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.disable(gl.SCISSOR_TEST); gl.depthMask(false); gl.colorMask(true, true, true, true);
      gl.enable(gl.BLEND); gl.blendEquation(gl.FUNC_ADD); gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.program); gl.bindVertexArray(this.vao);
      const tier = this.quality.update(dt);
      gl.uniform1f(gl.getUniformLocation(this.program, 'age'), age);
      gl.uniform1f(gl.getUniformLocation(this.program, 'aspect'), gl.drawingBufferWidth / Math.max(1, gl.drawingBufferHeight));
      gl.uniform1f(gl.getUniformLocation(this.program, 'pixel'), Math.min(devicePixelRatio || 1, VFX_BUDGET[tier].dpr));
      gl.drawArrays(gl.POINTS, 0, Math.min(this.count, VFX_BUDGET[tier].particles));
    } finally {
      gl.useProgram(program); gl.bindVertexArray(vao); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb); gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
      flags.forEach((flag, i) => enabled[i] ? gl.enable(flag) : gl.disable(flag));
      gl.depthMask(depthMask); gl.colorMask(mask[0], mask[1], mask[2], mask[3]); gl.blendFuncSeparate(blend[0], blend[1], blend[2], blend[3]); gl.blendEquationSeparate(blend[4], blend[5]);
    }
    return true;
  }
  dispose() { this.gl.deleteBuffer(this.buffer); this.gl.deleteVertexArray(this.vao); this.gl.deleteProgram(this.program); }
}
