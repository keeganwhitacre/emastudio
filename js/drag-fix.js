/**
 * Attaches robust drag-and-drop functionality to the questions list.
 */

let isDragInitialized = false;
let draggedItem = null;

function initializeDragAndDrop() {
    const list = document.getElementById('question-list'); 
    if (!list) return;

    // 1. Target the correct q-card elements
    // This part MUST run on every DOM mutation to catch new items
    const items = list.querySelectorAll('.q-card');
    items.forEach(item => {
        if (item.getAttribute('draggable') !== 'true') {
            item.setAttribute('draggable', 'true');
            const handle = item.querySelector('.q-drag-handle');
            if (handle) handle.style.cursor = 'grab';
        }
    });

    // Prevent attaching multiple duplicate event listeners on every DOM mutation
    if (isDragInitialized) return;
    isDragInitialized = true;

    // 2. Handle Drag Start
    list.addEventListener('dragstart', (e) => {
        const target = e.target.closest('.q-card');
        if (target) {
            draggedItem = target;
            e.dataTransfer.effectAllowed = 'move';
            // Delay visual feedback so the browser captures a solid drag ghost image
            requestAnimationFrame(() => {
                if (target) target.style.opacity = '0.5';
            });
        }
    });

    // 3. Handle Drag Over
    list.addEventListener('dragover', (e) => {
        e.preventDefault(); 
        e.dataTransfer.dropEffect = 'move';
        
        if (!draggedItem) return;
        
        const target = e.target.closest('.q-card');
        if (target && target !== draggedItem) {
            const rect = target.getBoundingClientRect();
            const next = (e.clientY - rect.top) / (rect.bottom - rect.top) > 0.5;
            list.insertBefore(draggedItem, next ? target.nextSibling : target);
        }
    });

    // 4. Handle Drop & Reorder State Array
    list.addEventListener('drop', (e) => {
        e.preventDefault();
        if (draggedItem) {
            draggedItem.style.opacity = '1';
            updateStateFromDOMOrder(list);
        }
        // CRITICAL: Clear draggedItem here too. If the DOM is wiped by renderQuestions, 
        // the dragend event often won't fire, leaving a ghost node in memory.
        draggedItem = null; 
    });

    // 5. Cleanup
    list.addEventListener('dragend', (e) => {
        if (draggedItem) {
            draggedItem.style.opacity = '1';
        }
        const target = e.target.closest('.q-card');
        if (target) {
            target.style.opacity = '1';
        }
        draggedItem = null;
    });
}

// Rebuilds state.ema.questions based on new DOM order
function updateStateFromDOMOrder(list) {
    const currentItems = list.querySelectorAll('.q-card');
    const reorderedQuestions = [];
    
    currentItems.forEach(item => {
        const qid = item.dataset.qid; 
        if (qid) { // Defensive check
            const questionObj = state.ema.questions.find(q => q.id === qid);
            if (questionObj) {
                reorderedQuestions.push(questionObj);
            }
        }
    });

    // Update the global state
    state.ema.questions = reorderedQuestions;

    // Re-render so numbers update visually
    if (typeof renderQuestions === 'function') renderQuestions(); 
    if (typeof schedulePreview === 'function') schedulePreview();
    
    if (typeof StorageManager !== 'undefined') StorageManager.saveLocalState();
}

// Disconnect/reconnect observer to avoid infinite loops when we renderQuestions()
const observer = new MutationObserver(() => {
    observer.disconnect();
    initializeDragAndDrop();
    const list = document.getElementById('question-list');
    if (list) observer.observe(list, { childList: true });
});

document.addEventListener('DOMContentLoaded', () => {
    const list = document.getElementById('question-list');
    if (list) {
        initializeDragAndDrop();
        observer.observe(list, { childList: true });
    }
});