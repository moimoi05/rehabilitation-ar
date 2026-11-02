import pathlib,json,time
import numpy as np,openvino as ov
path=pathlib.Path('rehab-data/models/official-detector/rtmpose-ort/rtmdet-nano/end2end.onnx')
report={'model':str(path),'source':'https://download.openmmlab.com/mmpose/v1/projects/rtmpose/rtmpose-cpu.zip','checkpoint_variant':'rtmdet_nano_8xb32-300e_coco-person_in1kpretrain-96154d0b (bundled detail.json)','cpu_fallback':False}
try:
 c=ov.Core();m=c.read_model(path);m.reshape({m.input(0):[1,3,320,320]})
 report['inputs']=[{'name':x.any_name,'shape':str(x.partial_shape)} for x in m.inputs]
 report['outputs']=[{'name':x.any_name,'shape':str(x.partial_shape)} for x in m.outputs]
 report['operators']=sorted({n.get_type_name() for n in m.get_ops()})
 supported=c.query_model(m,'GPU');report['unsupported_nodes']=[{'name':n.friendly_name,'op':n.get_type_name()} for n in m.get_ops() if n.friendly_name not in supported]
 t=time.perf_counter();compiled=c.compile_model(m,'GPU',{'PERFORMANCE_HINT':'LATENCY','INFERENCE_PRECISION_HINT':'f16','CACHE_DIR':'rehab-data/models/openvino-cache'})
 report['compile_ms']=(time.perf_counter()-t)*1000;report['execution_devices']=compiled.get_property('EXECUTION_DEVICES')
 t=time.perf_counter();out=compiled([np.zeros((1,3,320,320),np.float32)]);report['inference_ms']=(time.perf_counter()-t)*1000
 report['output_shapes']={p.any_name:list(x.shape) for p,x in out.items()};report['gpu_verified']=True
except Exception as exc:report['error']=str(exc);report['gpu_verified']=False
pathlib.Path('rehab-data/benchmarks/rtmpose-gpu-probe-20261101T083410Z/detector-probe.json').write_text(json.dumps(report,indent=2),encoding='utf8')
print(json.dumps(report,indent=2))
