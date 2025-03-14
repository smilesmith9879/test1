// 全局变量和状态
let isStreaming = false;
let videoCanvas, videoContext;
let videoPlaceholder;
let startStreamBtn, stopStreamBtn;

// 启用调试模式
const DEBUG_MODE = true;
function debugLog(...args) {
    if (DEBUG_MODE) {
        console.log('[DEBUG]', ...args);
    }
}

// 记录Socket.IO连接时间
const socketConnectStartTime = Date.now();

// 连接到Socket.IO服务器
const socket = io({
    transports: ['websocket', 'polling'], // 先尝试websocket，失败后尝试polling
    reconnectionAttempts: 10,  // 增加重连次数
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,  // 最大重连延迟
    timeout: 20000, // 增加连接超时时间
    pingTimeout: 60000,  // 匹配服务器端的ping超时设置
    pingInterval: 25000,  // 匹配服务器端的ping间隔
    forceNew: true // 强制创建新连接
});

console.log('Socket.IO连接初始化，时间:', new Date().toISOString());

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
    console.log('已连接到服务器，连接时间:', (Date.now() - socketConnectStartTime) + 'ms');
    console.log('Socket ID:', socket.id);
    
    // 在DOM就绪前连接会导致问题，检查相关DOM元素
    debugLog('连接时DOM元素状态:', {
        videoCanvasExists: !!videoCanvas,
        videoPlaceholderExists: !!videoPlaceholder,
        startBtnExists: !!startStreamBtn,
        stopBtnExists: !!stopStreamBtn
    });
    
    updateConnectionStatus(true);
    
    // 开始定期测量延迟
    setInterval(measureLatency, 3000);
    
    // 更新诊断面板
    updateDiagnosticPanel();
});

socket.on('connect_error', (error) => {
    console.error('Socket.IO连接错误:', error);
    updateConnectionStatus(false);
});

socket.on('connect_timeout', () => {
    console.error('Socket.IO连接超时');
    updateConnectionStatus(false);
});

socket.on('disconnect', (reason) => {
    console.log('与服务器断开连接，原因:', reason);
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
    
    // 每10帧或前5帧输出详细信息
    const shouldLogDetails = frameStats.received % 10 === 0 || frameStats.received < 5;
    
    try {
        debugLog('收到视频帧事件', {
            hasData: !!data,
            hasFrame: data && !!data.frame,
            frameLength: data && data.frame ? data.frame.length : 0,
            count: data && data.count ? data.count : 'unknown'
        });
        
        if (data && data.frame) {
            frameStats.received++;
            
            // 记录帧元数据
            if (data.count && data.size) {
                if (shouldLogDetails) {
                    console.log(`帧 #${data.count} 接收, 大小: ${Math.round(data.size/1024)}KB`);
                }
                frameStats.lastFrameSize = data.size;
            }
            
            // 检查视频元素状态
            if (frameStats.received <= 3 || shouldLogDetails) {
                debugLog('视频容器状态:', {
                    isStreaming: isStreaming,
                    canvasExists: !!videoCanvas,
                    contextExists: !!videoContext,
                    canvasDisplay: videoCanvas ? videoCanvas.style.display : 'undefined',
                    placeholderDisplay: videoPlaceholder ? videoPlaceholder.style.display : 'undefined',
                    canvasWidth: videoCanvas ? videoCanvas.width : 'undefined',
                    canvasHeight: videoCanvas ? videoCanvas.height : 'undefined'
                });
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
                debugLog('处理第一帧或单帧缓冲区');
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
    
    // 确保Canvas可见
    debugLog('设置视频容器显示状态', {
        beforeCanvasDisplay: videoCanvas.style.display,
        beforePlaceholderDisplay: videoPlaceholder.style.display
    });
    
    videoPlaceholder.style.display = 'none';
    videoCanvas.style.display = 'block';
    
    debugLog('视频容器显示状态已更新', {
        afterCanvasDisplay: videoCanvas.style.display,
        afterPlaceholderDisplay: videoPlaceholder.style.display
    });
    
    // 创建图像对象
    const img = new Image();
    
    // 图像加载完成的回调
    img.onload = () => {
        debugLog('图像加载成功', {
            imgWidth: img.width,
            imgHeight: img.height,
            canvasWidth: videoCanvas.width,
            canvasHeight: videoCanvas.height
        });
        
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
        try {
            videoContext.drawImage(img, offsetX, offsetY, drawWidth, drawHeight);
            debugLog('图像已绘制到Canvas上', {
                drawWidth, drawHeight, offsetX, offsetY
            });
            
            // 在画布上显示帧编号和时间戳，帮助调试
            videoContext.font = '16px Arial';
            videoContext.fillStyle = 'lime';
            videoContext.fillText(`帧 #${frameStats.displayed}`, 10, 20);
            
            const now = new Date().toLocaleTimeString();
            videoContext.fillText(now, 10, 40);
            
        } catch (drawError) {
            console.error('绘制图像时出错', drawError);
        }
        
        // 更新统计
        frameStats.displayed++;
        
        // 如果缓冲区中还有帧，处理下一帧
        if (frameBuffer.frames.length > 0) {
            requestAnimationFrame(processNextFrame);
        }
    };
    
    img.onerror = (error) => {
        console.error('加载图像时出错:', error);
        console.error('图像URL前30个字符:', img.src.substring(0, 30) + '...');
        
        // 尝试分析帧数据
        if (frameData) {
            if (frameData.length < 100) {
                console.error('帧数据长度异常短:', frameData.length);
            }
            if (!/^[A-Za-z0-9+/=]+$/.test(frameData)) {
                console.error('帧数据包含非base64字符');
            }
        }
        
        frameStats.errors++;
        
        // 如果缓冲区中还有帧，处理下一帧
        if (frameBuffer.frames.length > 0) {
            requestAnimationFrame(processNextFrame);
        }
    };
    
    // 设置图像源 - 确保正确使用base64格式
    try {
        if (!frameData || frameData.length < 10) {
            console.error('无效的帧数据, 长度:', frameData ? frameData.length : 0);
            return;
        }
        
        // 确保使用纯净的base64字符串
        const base64Pattern = /^[A-Za-z0-9+/=]+$/;
        if (!base64Pattern.test(frameData)) {
            console.warn('帧数据包含非base64字符，尝试清理');
            const cleanFrameData = frameData.replace(/[^A-Za-z0-9+/=]/g, '');
            img.src = 'data:image/jpeg;base64,' + cleanFrameData;
        } else {
            img.src = 'data:image/jpeg;base64,' + frameData;
        }
        
        debugLog('图像源已设置，数据前20个字符:', frameData.substring(0, 20) + '...');
        debugLog('图像源已设置，大小约: ' + Math.round(frameData.length/1024) + 'KB');
    } catch (error) {
        console.error('设置图像源时出错:', error);
    }
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
    
    console.log('DOM元素获取：', {
        videoCanvas: !!videoCanvas,
        videoPlaceholder: !!videoPlaceholder,
        startStreamBtn: !!startStreamBtn,
        stopStreamBtn: !!stopStreamBtn
    });
    
    // 检查是否存在缺失的DOM元素
    if (!videoCanvas || !videoPlaceholder || !startStreamBtn || !stopStreamBtn) {
        console.error('一些DOM元素未找到，这可能会导致视频显示问题!');
        alert('页面加载不完全，可能需要刷新页面，或检查HTML结构');
    }
    
    // 初始化canvas
    if (videoCanvas) {
        // 设置canvas大小
        videoCanvas.width = 640;
        videoCanvas.height = 480;
        
        // 确保canvas样式正确
        videoCanvas.style.backgroundColor = '#000';
        videoCanvas.style.display = 'none'; // 初始隐藏，等待视频流
        
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
            console.log('视频Canvas初始化成功');
            
            // 测试绘制能力
            try {
                videoContext.fillStyle = 'red';
                videoContext.fillRect(10, 10, 50, 50);
                console.log('Canvas绘制测试成功');
            } catch (e) {
                console.error('Canvas绘制测试失败', e);
            }
        } else {
            console.error('无法获取canvas上下文');
        }
    } else {
        console.error('找不到视频canvas元素');
    }
    
    // 确保placeholder正确显示
    if (videoPlaceholder) {
        videoPlaceholder.style.display = 'flex';
    } else {
        console.error('找不到视频placeholder元素');
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
    console.log('初始Socket连接状态:', socket.connected ? '已连接' : '未连接');
    
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