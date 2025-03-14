# 视频流测试项目

这是一个简单的视频流测试项目，用于测试摄像头视频实时传输功能。该项目使用Flask和Socket.IO来实现视频流传输。

## 功能特点

- 摄像头视频实时传输至网页浏览器
- 自动检测相机可用性，支持实际相机和模拟相机模式
- 视频流性能监控和诊断面板
- 网络延迟测量
- 帧率控制和优化

## 依赖库

- Python 3.6+
- Flask
- Flask-SocketIO
- OpenCV (cv2)
- NumPy
- eventlet (用于Socket.IO异步模式)

## 安装

1. 安装所需依赖：

```bash
pip install flask flask-socketio opencv-python numpy eventlet
```

2. 克隆或下载本项目

## 运行

在项目根目录下运行：

```bash
python app.py
```

然后在浏览器中访问：http://localhost:5000

## 使用方法

1. 打开网页后，如果相机可用，将自动启动视频流
2. 视频流状态和性能指标将显示在页面上
3. 使用"开始视频流"和"停止视频流"按钮控制视频流
4. 诊断面板提供详细的性能指标，包括帧率、延迟等

## 技术实现

- 使用Socket.IO实现实时通信
- 使用OpenCV捕获摄像头帧
- 使用Base64编码传输图像数据
- 使用Canvas显示视频帧
- 使用requestAnimationFrame优化渲染性能
- 实现帧缓冲机制，平滑播放

## 注意事项

- 如果没有检测到实际相机，将自动切换到模拟相机模式
- 在高网络延迟环境下，可能会出现视频卡顿
- 关闭浏览器标签页或窗口时，将自动停止视频流 