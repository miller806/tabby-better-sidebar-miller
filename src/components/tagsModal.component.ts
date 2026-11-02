import { AfterViewInit, Component, ElementRef, Input, ViewChild } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

/** Edits the comma-separated tags for a server. */
@Component({
    selector: 'sidebar-plus-tags-modal',
    template: require('./tagsModal.component.pug'),
})
export class TagsModalComponent implements AfterViewInit {
    @Input() targetName = ''
    @Input() text = ''

    @ViewChild('field') field: ElementRef<HTMLTextAreaElement>

    constructor (
        private modalInstance: NgbActiveModal,
    ) { }

    ngAfterViewInit (): void {
        setTimeout(() => {
            const el = this.field?.nativeElement
            el?.focus()
            el?.setSelectionRange(el.value.length, el.value.length)
        })
    }

    save (): void {
        this.modalInstance.close(this.text)
    }

    cancel (): void {
        this.modalInstance.dismiss()
    }
}
