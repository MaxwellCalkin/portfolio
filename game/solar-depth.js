/** Keep custom art shaders on Three's standard logarithmic depth convention. */
export function withSolarDepth(parameters) {
  const inject = (source, stage) => {
    const suffix = `\n#include <logdepthbuf_${stage}>\n`;
    const lastBrace = source.lastIndexOf('}');
    const prefix = `${stage === 'vertex' ? '#include <common>\n' : ''}#include <logdepthbuf_pars_${stage}>\n`;
    return prefix + source.slice(0, lastBrace) + suffix + source.slice(lastBrace);
  };
  return { ...parameters, vertexShader: inject(parameters.vertexShader, 'vertex'), fragmentShader: inject(parameters.fragmentShader, 'fragment') };
}
