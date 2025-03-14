// 全局变量和状态
let isStreaming = false;
let videoCanvas, videoContext;
let videoPlaceholder;
let startStreamBtn, stopStreamBtn;

// 连接到Socket.IO服务器
const socket = io({
    transports: ['websocket'],
    reconnectionAttempts: 5,
    reconnectionDelay: 1000
});

// 帧统计
const frameStats = {
    received: 0,
    displayed: 0,
    errors: 0,
    frameTimes: [],
    avgFps: 0,
    bufferSize: 0,
    lastFrameTime: 0,
    lastStatsUpdate: Date.now(),
    lastFrameSize: 0,
    lastReceiveTime: 0,
    lastRenderTime: 0,
    connectionIssues: 0
};

// 帧缓冲区
const frameBuffer = {
    maxSize: 3,  // 最多缓存3帧
    frames: [],
    add: function(frame) {
        if (this.frames.length >= this.maxSize) {
            this.frames.shift(); // 移除最旧的帧
        }
        this.frames.push(frame);
        frameStats.bufferSize = this.frames.length;
    },
    getNext: function() {
        if (this.frames.length > 0) {
            return this.frames.shift();
        }
        return null;
    },
    clear: function() {
        this.frames = [];
        frameStats.bufferSize = 0;
    }
};

// Socket.IO 事件处理
socket.on('connect', () => {
    console.log('已连接到服务器');
    updateConnectionStatus(true);
    
    // 开始定期测量延迟
    setInterval(measureLatency, 3000);
    
    // 更新诊断面板
    updateDiagnosticPanel();
});

socket.on('disconnect', () => {
    console.log('与服务器断开连接');
    updateConnectionStatus(false);
    isStreaming = false;
    
    // 更新UI
    videoPlaceholder.style.display = 'flex';
    videoCanvas.style.display = 'none';
    const streamStatusElem = document.getElementById('stream-status');
    if (streamStatusElem) {
        streamStatusElem.innerHTML = '<span class="status-dot inactive"></span>停止';
    }
    
    console.log('连接丢失 - 流状态已重置');
});

socket.on('status_update', (data) => {
    // 更新状态指示器
    updateStatusIndicators(data);
});

socket.on('video_frame', (data) => {
    const receiveStartTime = Date.now();
    
    try {
        if (data && data.frame) {
            frameStats.received++;
            
            // 记录帧元数据
            if (data.count && data.size) {
                console.log(`帧 #${data.count} 接收, 大小: ${Math.round(data.size/1024)}KB`);
                frameStats.lastFrameSize = data.size;
            }
            
            // 记录帧接收时间
            frameStats.lastReceiveTime = Date.now() - receiveStartTime;
            
            // 计算自上一帧的时间差
            if (frameStats.lastFrameTime > 0) {
                const timeDiff = receiveStartTime - frameStats.lastFrameTime;
                frameStats.frameTimes.push(timeDiff);
                // 只保留最近10个时间差
                if (frameStats.frameTimes.length > 10) {
                    frameStats.frameTimes.shift();
                }
                
                // 计算平均FPS
                if (frameStats.frameTimes.length > 0) {
                    const avgTime = frameStats.frameTimes.reduce((a, b) => a + b, 0) / frameStats.frameTimes.length;
                    frameStats.avgFps = Math.round(1000 / avgTime * 10) / 10;
                }
            }
            frameStats.lastFrameTime = receiveStartTime;
            
            // 更新性能统计
            const now = Date.now();
            if (now - frameStats.lastStatsUpdate > 2000) { // 每2秒更新一次状态
                console.log(`视频性能: 已接收=${frameStats.received}, 已显示=${frameStats.displayed}, 平均FPS=${frameStats.avgFps}, 错误=${frameStats.errors}`);
                updateVideoStats();
                updateDiagnosticPanel();  // 更新诊断面板
                frameStats.lastStatsUpdate = now;
            }
            
            // 将帧添加到缓冲区
            frameBuffer.add(data.frame);
            
            // 如果这是第一帧，立即处理
            if (frameStats.received === 1 || frameBuffer.frames.length === 1) {
                processNextFrame();
            }
        } else {
            console.error('收到无效的视频帧数据');
            frameStats.errors++;
        }
    } catch (error) {
        console.error('处理视频帧时出错:', error);
        frameStats.errors++;
    }
    
    // 更新最后活动时间
    const lastActivityElement = document.getElementById('last-activity');
    if (lastActivityElement) {
        const now = new Date();
        lastActivityElement.textContent = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    }
});

socket.on('stream_status', (data) => {
    console.log('收到流状态:', data.status);
    
    if (data.status === 'started') {
        console.log('视频流成功启动');
        isStreaming = true;
        videoPlaceholder.style.display = 'none';
        videoCanvas.style.display = 'block';
        updateStreamStatus(true);
        startStreamBtn.disabled = true;
        stopStreamBtn.disabled = false;
    } else if (data.status === 'stopped') {
        console.log('服务器停止视频流');
        isStreaming = false;
        videoPlaceholder.style.display = 'flex';
        videoCanvas.style.display = 'none';
        updateStreamStatus(false);
        startStreamBtn.disabled = false;
        stopStreamBtn.disabled = true;
        // 清空缓冲区
        frameBuffer.clear();
    } else if (data.status === 'error') {
        console.error(`流错误: ${data.message}`);
        alert(`流错误: ${data.message}`);
        isStreaming = false;
        videoPlaceholder.style.display = 'flex';
        videoCanvas.style.display = 'none';
        updateStreamStatus(false);
        startStreamBtn.disabled = false;
        stopStreamBtn.disabled = true;
    }
});

socket.on('ping_response', () => {
    const pingTime = Date.now() - lastPingTime;
    currentLatency = pingTime;
    
    // 更新诊断面板中的延迟
    const latencyElement = document.getElementById('latency');
    if (latencyElement) {
        latencyElement.textContent = `${currentLatency} ms`;
        
        // 根据延迟设置颜色
        if (currentLatency > 200) {
            latencyElement.style.color = '#FF5252';
        } else if (currentLatency > 100) {
            latencyElement.style.color = '#FFC107';
        } else {
            latencyElement.style.color = '#4CAF50';
        }
    }
});

// 更新UI状态函数
function updateConnectionStatus(connected) {
    const statusElem = document.getElementById('connection-status');
    if (statusElem) {
        if (connected) {
            statusElem.innerHTML = '<span class="status-dot active"></span>已连接';
        } else {
            statusElem.innerHTML = '<span class="status-dot inactive"></span>断开';
        }
    }
}

function updateStreamStatus(active) {
    const statusElem = document.getElementById('stream-status');
    if (statusElem) {
        if (active) {
            statusElem.innerHTML = '<span class="status-dot active"></span>活跃';
        } else {
            statusElem.innerHTML = '<span class="status-dot inactive"></span>停止';
        }
    }
}

function updateStatusIndicators(data) {
    // 相机状态
    const cameraStatusElem = document.getElementById('camera-status');
    if (cameraStatusElem) {
        if (data.camera_available) {
            cameraStatusElem.innerHTML = '<span class="status-dot available"></span>可用';
        } else {
            cameraStatusElem.innerHTML = '<span class="status-dot unavailable"></span>不可用';
        }
    }
    
    // 流状态
    if (data.is_streaming !== undefined) {
        updateStreamStatus(data.is_streaming);
        isStreaming = data.is_streaming;
        
        if (data.is_streaming) {
            videoPlaceholder.style.display = 'none';
            videoCanvas.style.display = 'block';
            startStreamBtn.disabled = true;
            stopStreamBtn.disabled = false;
        } else {
            videoPlaceholder.style.display = 'flex';
            videoCanvas.style.display = 'none';
            startStreamBtn.disabled = false;
            stopStreamBtn.disabled = true;
        }
    }
}

// 处理视频帧
function displayVideoFrame(frameData) {
    // 检查是否初始化了Canvas
    if (!videoCanvas || !videoContext) {
        console.error('视频画布未初始化');
        return;
    }
    
    // 创建图像对象
    const img = new Image();
    img.onload = () => {
        // 清除画布
        videoContext.clearRect(0, 0, videoCanvas.width, videoCanvas.height);
        
        // 绘制图像，保持纵横比
        const canvasRatio = videoCanvas.width / videoCanvas.height;
        const imgRatio = img.width / img.height;
        
        let drawWidth, drawHeight, offsetX, offsetY;
        
        if (canvasRatio > imgRatio) {
            // Canvas更宽，图像高度将填满
            drawHeight = videoCanvas.height;
            drawWidth = img.width * (drawHeight / img.height);
            offsetX = (videoCanvas.width - drawWidth) / 2;
            offsetY = 0;
        } else {
            // Canvas更高，图像宽度将填满
            drawWidth = videoCanvas.width;
            drawHeight = img.height * (drawWidth / img.width);
            offsetX = 0;
            offsetY = (videoCanvas.height - drawHeight) / 2;
        }
        
        // 绘制图像
        videoContext.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
        
        // 更新统计
        frameStats.displayed++;
        
        // 如果缓冲区中还有帧，处理下一帧
        if (frameBuffer.frames.length > 0) {
            requestAnimationFrame(processNextFrame);
        }
    };
    
    img.onerror = (error) => {
        console.error('加载图像时出错:', error);
        frameStats.errors++;
        
        // 如果缓冲区中还有帧，处理下一帧
        if (frameBuffer.frames.length > 0) {
            requestAnimationFrame(processNextFrame);
        }
    };
    
    // 设置图像源
    img.src = 'data:image/jpeg;base64,' + frameData;
}

// 创建一个处理帧的函数，可以独立调用
function processNextFrame() {
    const frameData = frameBuffer.getNext();
    if (frameData) {
        const renderStartTime = Date.now();
        displayVideoFrame(frameData);
        frameStats.lastRenderTime = Date.now() - renderStartTime;
        
        // 如果缓冲区中还有帧，安排下一个帧的处理
        if (frameBuffer.frames.length > 0) {
            // 使用requestAnimationFrame来优化渲染性能
            requestAnimationFrame(processNextFrame);
        }
    }
}

// 添加视频状态更新到UI
function updateVideoStats() {
    // 如果有视频状态显示元素，则更新它
    const statsElement = document.getElementById('video-stats');
    if (statsElement) {
        statsElement.innerHTML = `
            <div>FPS: ${frameStats.avgFps.toFixed(1)}</div>
            <div>缓冲: ${frameStats.bufferSize}/${frameBuffer.maxSize}</div>
            <div>已接收: ${frameStats.received}</div>
            <div>帧大小: ${Math.round(frameStats.lastFrameSize/1024)} KB</div>
        `;
    }
}

// 创建诊断面板
function createDiagnosticPanel() {
    const panel = document.getElementById('diagnostic-panel');
    if (!panel) return;
    
    panel.innerHTML = `
        <div class="diagnostic-item">
            <div class="diagnostic-label">帧率</div>
            <div id="frame-rate" class="diagnostic-value">0.0 FPS</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">帧缓冲</div>
            <div id="frame-buffer" class="diagnostic-value">0/3</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">帧大小</div>
            <div id="frame-size" class="diagnostic-value">0 KB</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">接收耗时</div>
            <div id="receive-time" class="diagnostic-value">0.0 ms</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">渲染耗时</div>
            <div id="render-time" class="diagnostic-value">0.0 ms</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">总帧数</div>
            <div id="total-frames" class="diagnostic-value">0</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">解码错误</div>
            <div id="decode-errors" class="diagnostic-value">0</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">连接状态</div>
            <div id="connection-status-diag" class="diagnostic-value">断开</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">延迟</div>
            <div id="latency" class="diagnostic-value">0 ms</div>
        </div>
        <div class="diagnostic-item">
            <div class="diagnostic-label">最后活动</div>
            <div id="last-activity" class="diagnostic-value">--:--:--</div>
        </div>
    `;
    
    console.log('诊断面板已创建');
}

// 更新诊断面板的值
function updateDiagnosticPanel() {
    // 检查面板是否已创建
    if (!document.getElementById('diagnostic-panel').innerHTML) {
        createDiagnosticPanel();
    }
    
    // 更新帧率
    const frameRateElement = document.getElementById('frame-rate');
    if (frameRateElement) {
        frameRateElement.textContent = `${frameStats.avgFps.toFixed(1)} FPS`;
        
        // 根据帧率设置颜色
        if (frameStats.avgFps < 5) {
            frameRateElement.style.color = '#FF5252';
        } else if (frameStats.avgFps < 10) {
            frameRateElement.style.color = '#FFC107';
        } else {
            frameRateElement.style.color = '#4CAF50';
        }
    }
    
    // 更新帧缓冲
    const frameBufferElement = document.getElementById('frame-buffer');
    if (frameBufferElement) {
        frameBufferElement.textContent = `${frameStats.bufferSize}/${frameBuffer.maxSize}`;
    }
    
    // 更新帧大小
    const frameSizeElement = document.getElementById('frame-size');
    if (frameSizeElement && frameStats.lastFrameSize) {
        frameSizeElement.textContent = `${(frameStats.lastFrameSize / 1024).toFixed(1)} KB`;
    }
    
    // 更新接收耗时
    const receiveTimeElement = document.getElementById('receive-time');
    if (receiveTimeElement && frameStats.lastReceiveTime) {
        receiveTimeElement.textContent = `${frameStats.lastReceiveTime.toFixed(1)} ms`;
    }
    
    // 更新渲染耗时
    const renderTimeElement = document.getElementById('render-time');
    if (renderTimeElement && frameStats.lastRenderTime) {
        renderTimeElement.textContent = `${frameStats.lastRenderTime.toFixed(1)} ms`;
    }
    
    // 更新总帧数
    const totalFramesElement = document.getElementById('total-frames');
    if (totalFramesElement) {
        totalFramesElement.textContent = frameStats.received.toString();
    }
    
    // 更新解码错误
    const decodeErrorsElement = document.getElementById('decode-errors');
    if (decodeErrorsElement) {
        decodeErrorsElement.textContent = frameStats.errors.toString();
        
        // 根据错误数设置颜色
        if (frameStats.errors > 10) {
            decodeErrorsElement.style.color = '#FF5252';
        } else if (frameStats.errors > 0) {
            decodeErrorsElement.style.color = '#FFC107';
        } else {
            decodeErrorsElement.style.color = '#4CAF50';
        }
    }
    
    // 更新连接状态
    const connectionStatusElement = document.getElementById('connection-status-diag');
    if (connectionStatusElement) {
        if (socket.connected) {
            connectionStatusElement.textContent = '已连接';
            connectionStatusElement.style.color = '#4CAF50';
        } else {
            connectionStatusElement.textContent = '断开连接';
            connectionStatusElement.style.color = '#FF5252';
        }
    }
    
    // 更新最后活动时间
    const lastActivityElement = document.getElementById('last-activity');
    if (lastActivityElement) {
        const now = new Date();
        lastActivityElement.textContent = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}`;
    }
}

// 测量网络延迟
let lastPingTime = 0;
let currentLatency = 0;

function measureLatency() {
    lastPingTime = Date.now();
    socket.emit('ping_request');
}

// 重置诊断统计数据
function resetDiagnosticStats() {
    frameStats.received = 0;
    frameStats.displayed = 0;
    frameStats.errors = 0;
    frameStats.frameTimes = [];
    frameStats.avgFps = 0;
    frameStats.bufferSize = 0;
    frameStats.lastFrameTime = 0;
    frameStats.lastStatsUpdate = Date.now();
    frameStats.lastFrameSize = 0;
    frameStats.lastReceiveTime = 0;
    frameStats.lastRenderTime = 0;
    frameStats.connectionIssues = 0;
    
    // 更新UI
    updateDiagnosticPanel();
    
    console.log('诊断统计已重置');
}

// 初始化
document.addEventListener('DOMContentLoaded', function() {
    console.log('页面加载完成，初始化组件...');
    
    // 获取DOM元素
    videoCanvas = document.getElementById('video-canvas');
    videoPlaceholder = document.getElementById('video-placeholder');
    startStreamBtn = document.getElementById('start-stream-btn');
    stopStreamBtn = document.getElementById('stop-stream-btn');
    
    // 初始化canvas
    if (videoCanvas) {
        // 设置canvas大小
        videoCanvas.width = 640;
        videoCanvas.height = 480;
        
        // 获取绘图上下文
        videoContext = videoCanvas.getContext('2d');
        if (videoContext) {
            // 绘制初始消息
            videoContext.fillStyle = 'black';
            videoContext.fillRect(0, 0, videoCanvas.width, videoCanvas.height);
            videoContext.font = '20px Arial';
            videoContext.fillStyle = 'white';
            videoContext.textAlign = 'center';
            videoContext.fillText('正在等待视频流...', videoCanvas.width / 2, videoCanvas.height / 2);
        } else {
            console.error('无法获取canvas上下文');
        }
    } else {
        console.error('找不到视频canvas元素');
    }
    
    // 创建诊断面板
    createDiagnosticPanel();
    
    // 初始化按钮状态
    if (startStreamBtn) {
        startStreamBtn.addEventListener('click', () => {
            console.log('请求开始视频流');
            socket.emit('start_stream');
        });
    }
    
    if (stopStreamBtn) {
        stopStreamBtn.addEventListener('click', () => {
            console.log('请求停止视频流');
            socket.emit('stop_stream');
        });
        stopStreamBtn.disabled = true;  // 初始状态下禁用
    }
    
    // 初始化连接状态
    updateConnectionStatus(socket.connected);
    
    // 如果已经连接，则测量一次延迟
    if (socket.connected) {
        measureLatency();
    }
    
    // 页面可见性变化处理
    document.addEventListener('visibilitychange', () => {
        console.log('页面可见性变化:', document.hidden ? '隐藏' : '可见');
        
        if (document.hidden) {
            // 页面被隐藏，暂停某些处理，但不停止视频流
            console.log('页面隐藏');
        } else {
            // 页面变为可见
            console.log('页面可见');
            if (isStreaming) {
                console.log('视频流正在运行，恢复处理');
            }
        }
    });
}); 