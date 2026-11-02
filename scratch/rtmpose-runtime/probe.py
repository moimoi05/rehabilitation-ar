import json, hashlib, time, platform, pathlib
from datetime import datetime, timezone
import openvino as ov
import numpy as np
root=pathlib.Path(__file__).resolve().parents[2]
model_path=next((root/'rehab-data/models/rtmpose-m-wholebody-official').rglob('end2end.onnx'))
run=root/'rehab-data/benchmarks'/('rtmpose-gpu-probe-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
run.mkdir(parents=True,exist_ok=False)
report={'status':'INCOMPLETE_RUNTIME_PROBE','not_a_completed_benchmark':True,'runtime':'OpenVINO','version':ov.__version__,'platform':platform.platform(),'model':str(model_path),'model_sha256':hashlib.sha256(model_path.read_bytes()).hexdigest(),'official_url':'https://download.openmmlab.com/mmpose/v1/projects/rtmposev1/onnx_sdk/rtmpose-m_simcc-ucoco_dw-ucoco_270e-256x192-c8b76419_20230728.zip','cpu_fallback':False}
try:
 c=ov.Core(); report['available_devices']=c.available_devices
 report['device']=c.get_property('GPU','FULL_DEVICE_NAME')
 model=c.read_model(model_path)
 model.reshape({model.input(0):[1,3,256,192]})
 report['inputs']=[{'name':x.any_name,'shape':str(x.partial_shape),'type':str(x.element_type)} for x in model.inputs]
 report['outputs']=[{'name':x.any_name,'shape':str(x.partial_shape),'type':str(x.element_type)} for x in model.outputs]
 report['operators']=sorted({n.get_type_name() for n in model.get_ops()})
 supported=c.query_model(model,'GPU')
 report['unsupported_nodes']=[n.friendly_name for n in model.get_ops() if n.friendly_name not in supported]
 t=time.perf_counter(); compiled=c.compile_model(model,'GPU',{'PERFORMANCE_HINT':'LATENCY','INFERENCE_PRECISION_HINT':'f16'}); report['compile_ms']=(time.perf_counter()-t)*1000
 report['execution_devices']=compiled.get_property('EXECUTION_DEVICES')
 report['precision_hint']=str(compiled.get_property('INFERENCE_PRECISION_HINT'))
 x=np.zeros((1,3,256,192),np.float32)
 durations=[]
 for i in range(12):
  t=time.perf_counter(); outputs=compiled([x]); elapsed=(time.perf_counter()-t)*1000
  if i>=2:durations.append(elapsed)
 report['probe_inference_ms']=durations
 report['output_shapes']={port.any_name:list(value.shape) for port,value in outputs.items()}
 report['outputs_finite']=all(np.isfinite(value).all().item() for value in outputs.values())
 report['gpu_graph_execution_verified']=report['execution_devices']==['GPU.0'] and report['outputs_finite']
except Exception as exc:
 report['error']=str(exc); report['gpu_graph_execution_verified']=False
(run/'runtime-probe.json').write_text(json.dumps(report,indent=2),encoding='utf8')
(run/'manifest.json').write_text(json.dumps({'status':'INCOMPLETE','type':'runtime compatibility probe','missing_artifacts':['annotated.mp4','landmarks.jsonl','fps.csv','summary.json','report.md'],'evidence':'runtime-probe.json'},indent=2),encoding='utf8')
print(json.dumps({'directory':str(run),**report},indent=2))
