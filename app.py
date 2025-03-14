#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import time
import json
import threading
import logging
import base64
import argparse
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
import cv2
import numpy as np

# 配置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# 初始化Flask应用
app = Flask(__name__)
app.config['SECRET_KEY'] = 'videostreamtest2023'

# 优化Socket.IO配置
socketio = SocketIO(
    app, 
    cors_allowed_origins="*", 
    async_mode='eventlet',
    ping_timeout=10,
    ping_interval=5,
    max_http_buffer_size=5 * 1024 * 1024,
    transports=['websocket']  
)

# 模拟相机类，用于测试无相机情况
class SimulatedCamera:
    def __init__(self):
        self.frame_count = 0
        # 创建一个带有文字的彩色测试图像
        self.test_image = np.zeros((480, 640, 3), dtype=np.uint8)
        cv2.rectangle(self.test_image, (50, 50), (590, 430), (0, 0, 255), 2)
        cv2.putText(self.test_image, "测试视频流", (180, 240), cv2.FONT_HERSHEY_SIMPLEX, 1.5, (255, 255, 255), 2)
        
    def read(self):
        # 增加帧计数
        self.frame_count += 1
        
        # 创建带有动态时间的副本
        frame = self.test_image.copy()
        
        # 添加动态时间和帧计数
        time_now = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
        cv2.putText(frame, time_now, (180, 300), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 1)
        cv2.putText(frame, f"Frame: {self.frame_count}", (180, 340), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 1)
        
        # 模拟帧率控制
        time.sleep(0.05)  # 大约20FPS
        
        return True, frame

# 初始化变量
is_streaming = False
streaming_thread = None
camera_available = False
camera = None
camera_lock = threading.RLock()  # 相机资源锁

# 初始化相机
try:
    logger.info("初始化相机...")
    camera = cv2.VideoCapture(0)
    
    # 尝试设置为MJPG格式提高效率
    camera.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
    camera.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    camera.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    camera.set(cv2.CAP_PROP_FPS, 30)
    
    # 获取实际相机设置
    actual_width = camera.get(cv2.CAP_PROP_FRAME_WIDTH)
    actual_height = camera.get(cv2.CAP_PROP_FRAME_HEIGHT)
    actual_fps = camera.get(cv2.CAP_PROP_FPS)
    actual_format = camera.get(cv2.CAP_PROP_FOURCC)
    format_str = chr(int(actual_format) & 0xFF) + chr((int(actual_format) >> 8) & 0xFF) + chr((int(actual_format) >> 16) & 0xFF) + chr((int(actual_format) >> 24) & 0xFF)
    
    logger.info(f"相机设置 - 宽度: {actual_width}, 高度: {actual_height}, FPS: {actual_fps}, 格式: {format_str}")
    
    # 检查相机是否正常工作
    ret, frame = camera.read()
    if ret:
        camera_available = True
        logger.info(f"相机初始化成功: 帧大小 {frame.shape}")
    else:
        logger.error("相机连接但无法捕获帧")
        logger.info("使用模拟相机")
except Exception as e:
    logger.error(f"初始化相机失败: {e}")
    logger.info("使用模拟相机")

# 如果硬件相机不可用，使用模拟相机
if not camera_available:
    camera = SimulatedCamera()
    camera_available = True
    logger.info("已启用模拟相机")

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

# 视频流函数
def generate_frames():
    global is_streaming, camera_available, camera, camera_lock
    
    logger.info("视频流线程启动")
    frame_count = 0
    error_count = 0
    last_log_time = time.time()
    fps_stats = []  # 存储每秒处理的帧数统计
    
    # 视频帧率和质量设置
    TARGET_FPS = 20  # 目标帧率
    FRAME_WIDTH = 640
    FRAME_HEIGHT = 480
    JPEG_QUALITY = 80  # JPEG质量
    
    logger.info(f"视频流参数 - 目标FPS: {TARGET_FPS}, 分辨率: {FRAME_WIDTH}x{FRAME_HEIGHT}, JPEG质量: {JPEG_QUALITY}")
    
    while is_streaming and camera_available:
        loop_start = time.time()  # 测量每帧处理时间
        frame_processed = False
        
        try:
            # 获取相机锁
            lock_start = time.time()
            acquired = camera_lock.acquire(timeout=0.1)
            lock_time = time.time() - lock_start
            
            if lock_time > 0.05:  # 如果获取锁的时间过长，记录日志
                logger.warning(f"视频流: 相机锁获取耗时 {lock_time:.3f}s")
                
            if not acquired:
                logger.warning("视频流: 无法获取相机锁，跳过此帧")
                time.sleep(0.01)  # 短暂等待
                continue
                
            try:
                # 读取相机帧，测量时间
                read_start = time.time()
                success, frame = camera.read()
                read_time = time.time() - read_start
                
                if read_time > 0.1:  # 如果读取时间过长，记录日志
                    logger.warning(f"视频流: 相机读取耗时 {read_time:.3f}s")
                
                if not success:
                    error_count += 1
                    logger.error(f"无法从相机读取帧 (尝试 {error_count})")
                    if error_count > 5:
                        logger.error("连续帧读取失败次数过多，检查相机...")
                        # 尝试检查相机状态
                        if hasattr(camera, 'isOpened') and not camera.isOpened():
                            logger.error("相机似乎已关闭，尝试重新打开")
                            try:
                                camera.release()
                                time.sleep(1)  # 给相机更多时间重置
                                
                                # 重新打开相机并设置参数
                                camera = cv2.VideoCapture(0)
                                camera.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
                                camera.set(cv2.CAP_PROP_FRAME_WIDTH, FRAME_WIDTH)
                                camera.set(cv2.CAP_PROP_FRAME_HEIGHT, FRAME_HEIGHT)
                                camera.set(cv2.CAP_PROP_FPS, TARGET_FPS)
                                
                                ret_test, _ = camera.read()
                                if ret_test:
                                    logger.info("相机重新打开成功")
                                    error_count = 0
                                else:
                                    logger.error("重新打开相机失败")
                                    camera_available = False
                                    break
                            except Exception as cam_error:
                                logger.error(f"重新打开相机时出错: {cam_error}")
                                camera_available = False
                                break
                        error_count = 0
                    time.sleep(0.1)
                    continue
                
                # 成功读取帧
                frame_processed = True
                error_count = 0
                frame_count += 1
                    
                # 处理前记录原始帧大小
                original_shape = frame.shape
                
                # 调整大小保持原始分辨率
                # frame = cv2.resize(frame, (FRAME_WIDTH, FRAME_HEIGHT))
                
                # 添加一个简单的HUD
                cv2.putText(frame, f"Frame: {frame_count}", (10, 30), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                
                current_time = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
                cv2.putText(frame, current_time, (10, 60), 
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
                
                # 确保图像颜色空间正确
                if len(frame.shape) < 3:
                    frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
                elif frame.shape[2] == 1:
                    frame = cv2.cvtColor(frame, cv2.COLOR_GRAY2BGR)
                
                # 使用优化的JPEG编码参数
                try:
                    encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), JPEG_QUALITY]
                    encode_start = time.time()
                    _, buffer = cv2.imencode('.jpg', frame, encode_param)
                    frame_base64 = base64.b64encode(buffer).decode('utf-8')
                    encode_time = time.time() - encode_start
                    
                    if encode_time > 0.1:  # 如果编码时间过长，记录日志
                        logger.warning(f"视频流: 帧编码耗时 {encode_time:.3f}s")
                    
                    # 为帧添加序号和时间戳，便于调试
                    frame_data = {
                        'frame': frame_base64,
                        'count': frame_count,
                        'time': time.time(),
                        'size': len(frame_base64)
                    }
                    
                    # 每10帧记录一次详细信息
                    if frame_count % 10 == 0:
                        logger.debug(f"帧 #{frame_count}: 大小={len(frame_base64)/1024:.1f}KB, 编码时间={encode_time*1000:.1f}ms")
                    
                    # 发送帧，测量发送时间
                    emit_start = time.time()
                    # 逐个发送帧到各个客户端，而不是广播给所有客户端
                    clients = socketio.server.get_namespace('/')._get_clients()
                    client_count = len(clients)
                    
                    for client_sid in clients:
                        socketio.emit('video_frame', frame_data, room=client_sid)
                        
                    emit_time = time.time() - emit_start
                    
                    if emit_time > 0.2:  # 如果发送时间过长，记录日志
                        logger.warning(f"视频流: 向 {client_count} 个客户端发送帧耗时 {emit_time:.3f}s")
                    
                    # 每处理100帧，记录一次总体信息
                    if frame_count % 100 == 0:
                        logger.info(f"视频流: 已发送 {frame_count} 帧")
                    
                    # 每秒记录一次性能统计
                    current_time = time.time()
                    if current_time - last_log_time >= 1.0:
                        fps = len(fps_stats)
                        fps_stats.clear()
                        logger.info(f"视频流性能: {fps} FPS, 最后帧大小: {len(frame_base64)/1024:.1f}KB")
                        last_log_time = current_time
                    else:
                        fps_stats.append(1)
                    
                    # 帧率控制
                    process_time = time.time() - loop_start
                    sleep_time = max(0, 1.0/TARGET_FPS - process_time)
                    if sleep_time > 0:
                        time.sleep(sleep_time)
                    elif process_time > 1.5/TARGET_FPS:  # 如果处理时间超过目标帧率的1.5倍，记录警告
                        logger.warning(f"视频流: 帧处理时间 {process_time:.3f}s 超过目标帧时间 {1.0/TARGET_FPS:.3f}s")
                        
                except Exception as encode_error:
                    logger.error(f"帧编码错误: {encode_error}")
                    time.sleep(0.1)
            
            finally:
                # 确保在任何情况下都释放锁
                camera_lock.release()
                
        except Exception as e:
            logger.error(f"视频流处理错误: {e}")
            time.sleep(0.1)
        
        # 如果帧没有处理成功，添加简短延迟
        if not frame_processed:
            time.sleep(0.05)
    
    logger.info(f"视频流停止，共发送 {frame_count} 帧")

# Socket.IO事件
@socketio.on('connect')
def handle_connect():
    global is_streaming, streaming_thread
    
    client_id = request.sid
    logger.info(f"客户端连接: {client_id}")
    
    # 发送状态更新给新连接的客户端
    emit('status_update', {
        'camera_available': camera_available,
        'is_streaming': is_streaming
    })
    
    # 自动启动视频流
    if camera_available:
        if not is_streaming:
            try:
                # 如果没有活跃的视频流，启动一个新的
                is_streaming = True
                streaming_thread = threading.Thread(target=generate_frames)
                streaming_thread.daemon = True
                streaming_thread.start()
                emit('stream_status', {'status': 'started'})
                logger.info(f"视频流自动启动，客户端: {client_id}")
            except Exception as e:
                logger.error(f"启动视频流错误: {e}")
                emit('stream_status', {'status': 'error', 'message': str(e)})
        else:
            # 如果视频流已经在运行，只需向此客户端发送状态通知
            emit('stream_status', {'status': 'started'})
            logger.info(f"已有视频流连接到新客户端: {client_id}")

@socketio.on('disconnect')
def handle_disconnect():
    global is_streaming
    
    client_id = request.sid
    logger.info(f"客户端断开连接: {client_id}")
    
    # 获取实际的活跃连接数量
    active_clients = len(socketio.server.eio.sockets)
    logger.info(f"剩余活跃客户端: {active_clients}")
    
    # 如果没有客户端了，停止视频流
    if active_clients <= 1 and is_streaming:
        logger.info("停止视频流 - 没有客户端")
        is_streaming = False

@socketio.on('start_stream')
def handle_start_stream():
    global is_streaming, streaming_thread
    
    logger.info(f"客户端请求开始流: {request.sid}")
    
    if not is_streaming and camera_available:
        is_streaming = True
        streaming_thread = threading.Thread(target=generate_frames)
        streaming_thread.daemon = True
        streaming_thread.start()
        emit('stream_status', {'status': 'started'})
        logger.info("视频流启动")
    else:
        if not camera_available:
            logger.error("相机不可用")
            emit('stream_status', {'status': 'error', 'message': '相机不可用'})
        elif is_streaming:
            logger.info("流已经处于活跃状态，发送状态更新")
            emit('stream_status', {'status': 'started'})
        else:
            logger.error("启动流时发生未知错误")
            emit('stream_status', {'status': 'error', 'message': '启动流时发生未知错误'})

@socketio.on('stop_stream')
def handle_stop_stream():
    global is_streaming
    
    logger.info(f"客户端请求停止流: {request.sid}")
    
    if is_streaming:
        is_streaming = False
        emit('stream_status', {'status': 'stopped'})
        logger.info("视频流停止")
    else:
        logger.info("没有活跃的流可停止")
        emit('stream_status', {'status': 'stopped'})

@socketio.on('ping_request')
def handle_ping_request():
    # 立即响应ping请求，用于测量延迟
    emit('ping_response')

if __name__ == '__main__':
    try:
        # 检查必要的依赖库
        try:
            cv2_version = cv2.__version__
            logger.info(f"使用OpenCV版本: {cv2_version}")
        except:
            logger.error("OpenCV (cv2) 未正确安装!")
        
        # 检查numpy
        try:
            np_version = np.__version__
            logger.info(f"使用NumPy版本: {np_version}")
        except:
            logger.error("NumPy未正确安装!")
        
        # 创建必要的目录
        os.makedirs('static', exist_ok=True)
        os.makedirs('templates', exist_ok=True)
        
        # 记录系统信息
        try:
            import platform
            system_info = platform.uname()
            logger.info(f"在 {system_info.system} {system_info.release}, Python {platform.python_version()} 上运行")
        except:
            logger.info("无法获取详细的系统信息")
        
        # 启动Flask应用
        logger.info("启动服务器在 0.0.0.0:5000")
        socketio.run(app, host='0.0.0.0', port=5000, debug=False)
    except KeyboardInterrupt:
        logger.info("服务器关闭请求")
    finally:
        # 清理资源
        if camera_available and hasattr(camera, 'release'):
            camera.release()
        logger.info("服务器关闭完成") 