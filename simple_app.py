#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import time
import threading
import logging
import base64
from flask import Flask, render_template, jsonify
from flask_socketio import SocketIO, emit
import cv2
import numpy as np

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 初始化Flask应用
app = Flask(__name__)
app.config['SECRET_KEY'] = 'simplevideostreamtest'

# 简化版Socket.IO配置
socketio = SocketIO(app, cors_allowed_origins="*")

# 模拟相机类
class SimulatedCamera:
    def __init__(self):
        self.frame_count = 0
        self.test_image = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.rectangle(self.test_image, (50, 50), (590, 430), (0, 0, 255), 2)
        cv2.putText(self.test_image, "测试视频流", (180, 240), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (255, 255, 255), 2)
        
    def read(self):
        self.frame_count += 1
        frame = self.test_image.copy()
        time_now = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        cv2.putText(frame, time_now, (180, 300), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 1)
        cv2.putText(frame, f"Frame: {self.frame_count}", (180, 340), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 1)
        time.sleep(0.05)
        return True, frame

# 全局变量
is_streaming = False
streaming_thread = None
camera = None
camera_available = False

# 初始化相机
try:
    logger.info("初始化相机...")
    camera = cv2.VideoCapture(0)
    ret, frame = camera.read()
    if ret:
        camera_available = True
        logger.info(f"相机初始化成功: 帧大小 {frame.shape}")
    else:
        logger.error("相机连接但无法捕获帧")
except Exception as e:
    logger.error(f"初始化相机失败: {e}")

# 如果实际相机不可用，使用模拟相机
if not camera_available:
    camera = SimulatedCamera()
    camera_available = True
    logger.info("使用模拟相机")

# 视频流线程函数
def video_stream_thread():
    global is_streaming
    logger.info("视频流线程启动")
    frame_count = 0
    
    while is_streaming and camera_available:
        # 读取一帧
        success, frame = camera.read()
        if not success:
            logger.error("无法读取视频帧")
            time.sleep(0.1)
            continue
            
        # 处理帧
        frame_count += 1
        current_time = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        cv2.putText(frame, f"Frame: {frame_count}", (10, 30), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        cv2.putText(frame, current_time, (10, 60), 
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        
        # 编码帧为JPEG
        try:
            _, buffer = cv2.imencode('.jpg', frame, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
            frame_base64 = base64.b64encode(buffer).decode('utf-8')
            
            # 发送帧到客户端
            frame_data = {
                'frame': frame_base64,
                'count': frame_count
            }
            socketio.emit('video_frame', frame_data)
            
            # 控制帧率
            time.sleep(0.05)  # 约20fps
            
        except Exception as e:
            logger.error(f"处理帧错误: {e}")
            time.sleep(0.1)
    
    logger.info(f"视频流停止，共发送 {frame_count} 帧")

# 路由
@app.route('/')
def index():
    return render_template('index.html', camera_available=camera_available)

@app.route('/status')
def status():
    return jsonify({
        'camera_available': camera_available,
        'is_streaming': is_streaming
    })

# Socket.IO事件
@socketio.on('connect')
def handle_connect():
    global is_streaming, streaming_thread
    
    logger.info(f"客户端连接")
    
    # 发送状态
    emit('status_update', {
        'camera_available': camera_available,
        'is_streaming': is_streaming
    })
    
    # 自动启动流
    if camera_available and not is_streaming:
        try:
            is_streaming = True
            streaming_thread = threading.Thread(target=video_stream_thread)
            streaming_thread.daemon = True
            streaming_thread.start()
            emit('stream_status', {'status': 'started'})
            logger.info("视频流自动启动")
        except Exception as e:
            logger.error(f"启动视频流错误: {e}")
            emit('stream_status', {'status': 'error', 'message': str(e)})

@socketio.on('disconnect')
def handle_disconnect():
    logger.info("客户端断开连接")

@socketio.on('start_stream')
def handle_start_stream():
    global is_streaming, streaming_thread
    
    if not is_streaming and camera_available:
        is_streaming = True
        streaming_thread = threading.Thread(target=video_stream_thread)
        streaming_thread.daemon = True
        streaming_thread.start()
        emit('stream_status', {'status': 'started'})
        logger.info("视频流启动")
    else:
        emit('stream_status', {'status': 'already_started'})

@socketio.on('stop_stream')
def handle_stop_stream():
    global is_streaming
    
    if is_streaming:
        is_streaming = False
        emit('stream_status', {'status': 'stopped'})
        logger.info("视频流停止")
    else:
        emit('stream_status', {'status': 'already_stopped'})

@socketio.on('ping_request')
def handle_ping_request():
    emit('ping_response')

if __name__ == '__main__':
    try:
        logger.info(f"使用OpenCV版本: {cv2.__version__}")
        logger.info(f"使用NumPy版本: {np.__version__}")
        
        # 记录系统信息
        try:
            import platform
            system_info = platform.uname()
            logger.info(f"在 {system_info.system} {system_info.release}, Python {platform.python_version()} 上运行")
        except:
            pass
        
        # 启动应用
        logger.info("启动服务器在 0.0.0.0:5000")
        socketio.run(app, host='0.0.0.0', port=5000, debug=False)
    except KeyboardInterrupt:
        logger.info("服务器关闭请求")
    finally:
        if camera_available and hasattr(camera, 'release'):
            camera.release()
        logger.info("服务器关闭完成") 